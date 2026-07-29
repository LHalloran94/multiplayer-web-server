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
// ALL-FINE (2026-07-26): terrain cell was 24px; now 8px so terrain matches the fine-liquid resolution
// (grid 640×135 → 1920×405). Reactions/dig/collision/render become fine-granular. The fine-liquid subsystem
// is now THE liquid path (ratio 1 = one liquid cell per terrain cell), gated by liquidCfg.fine (always on;
// git branch is the A/B). 1 stays as the ratio and is 1 everywhere now.
const TERRAIN_CELL = 8;
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
  ledgeSpill: true,      // step 1b: liquid spills DIAGONALLY over the edge of a ledge. off = it only falls straight down + spreads on flat ground
  lateralLevel: true,    // steps 1c/1d: liquid flows SIDEWAYS to find a flat level. off = it piles up where it lands (no spreading)
  perLiquidLevel: true,  // step 2c: each liquid flattens its OWN layer across columns (heavy ends flat along the bottom)
  viscosity: false,      // per-liquid LEVEL_VISC throttle: denser liquids ooze flat slower. off = ALL liquids level at full speed
  fineFlatSteps: 3,      // (1d) surface flat-settle: sub-steps/tick it may run in ≈ its spread speed in cells/tick. 0 = uncapped (every sub-step)
  // ⚠️ DEFAULT OFF since 2026-07-29. This is the BLANKET rule: a cell in a column that still holds ANY inversion may
  // not level at all. It freezes the whole column — including its free surface — until the column has finished
  // sorting, which leaves a liquid heap standing as a terraced mound (measured: the heap held its shape until t176
  // with it on vs t46 with it off, and settled 306 vs 125). And it turns out it was never doing the job: with the
  // per-EXCHANGE gate (finePerLiquidSortGate) on, a buried blob spreads 13 columns whether this is on or off; with
  // that gate off it spreads 50–58 either way. So the spread limiting is entirely the other rule's doing.
  sortBeforeLevel: false,
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
  // ── DROPLET CASCADE — DELETED 2026-07-29 (all-fine track, slice 1 of the coarse deletion).
  // It was the 2026-07-20 streaming rewrite: a ledge spill left the grid as droplets that carried real liquid and
  // deposited it on landing, developed over eleven bench iterations (scratchpad/liquid-droplet-stream.html, still
  // there, and the whole design log is in auto-memory project_liquid_streaming). It shipped OFF: the ALL-FINE terrain
  // move made it redundant, because at 8px cells the grid itself resolves a falling stream, which is the entire
  // problem droplets existed to solve. `droplets`, `dropUnit/Fall/Spread/SpreadFlow/SpawnH/Weir/Stratify/LandSpread/
  // TermFall/ImpactCurve/SpreadRef/SpreadWide/EdgeFill/ColSpace` all went with it, along with dropletTickRoom,
  // spawnDroplets, the `liquid-drops` wire and the client's local replay.
  // (streamFullClear — a brim-full cell drops its stream tag — was read only by the coarse sim and went with it.)
  // LEVELLING GATE — which cells are excluded from lateral levelling (1c/1d/2c) as "still falling". The old test (canFall)
  // also counted a cell that could shed DIAGONALLY over a nearby edge, so pool cells sitting at an edge never levelled →
  // the blocky/stair surface near drops. A cell is genuinely a STREAM only if it is TAGGED (a ledge spill, carried down)
  // or has straight-down room (a vertical drop the tag never marks). 0 = old canFall · 1 = tagged-or-straight-down (fixes
  // the blocky edge; keeps waterfalls from fanning) · 2 = tagged-ONLY (experiment: simplest, but untagged vertical drops fan).
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
  // (`fine` and `sub` are gone. `fine` gated the fine sim against the coarse one, and there is no coarse one; `sub`
  //  was the fine-cells-per-terrain-cell ratio, which is 1 now that terrain is itself 8px — every ÷/×SUB² mapping
  //  helper collapses to identity at 1. roomFineSub is still carried per room and defaults to 1.)
  // FINE: use the diagonal ledge spill (1b). OFF ⇒ rely on lateral levelling (1c) moving liquid into the edge cell + it
  // falling straight down (1a) next tick — same end state, one tick slower, no diagonal/geometry rule (a diagonal gap
  // between two solids is a sealed corner anyway). Fine-only so the coarse system is unaffected.
  fineLedge: false,
  // FINE PHYSICS SUB-STEPS: run the WHOLE fine tick this many times/tick → ALL movement (fall/spill/level/sort) K× faster,
  // recovering the speed fine cells lose to being smaller. Levelling is O(width²) so fine is ~SUB²≈9× slower than coarse →
  // K≈9 matches coarse. Local, no teleport, broadcast accumulated (wire ~unchanged). 1 = unchanged.
  fineLevelSteps: 9,
  // (1) QUIESCENCE (perf): freeze a fine cell that has NOT MOVED for fineQuiesceTicks ticks — drop it from the active set
  // so it stops being processed AND broadcast. Trims the settling wake-front + idle halo. Keys off "did it move (incl.
  // density sort) this tick", so an inverting cell is never frozen. Pure perf: only removes from the work-set, never
  // moves mass. A neighbour move re-adds it. OFF = no change.
  fineQuiesce: false,
  fineQuiesceTicks: 6,
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
  fineSortSteps: 1,   // DEFAULT 1 (user's choice): one slow, visible density-sort pass per tick while levelling keeps the full K
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
  finePerLiquidSortGate: true,
  // ⭐⭐ ONE CELL PER SORT PASS. `list` is scanned BOTTOM-UP (right for falling), which let each higher cell pull the
  // same light liquid up one more cell within a single pass — so a sliver rode the whole height of a pool in one
  // sub-step and was then filmed across it by 2c, while the bulk rose at the expected rate. This makes a parcel
  // advance exactly one cell per sort pass, which is what "density-sort passes/tick" is supposed to mean.
  fineSortOnePerPass: true,
  // CELL CAPACITY = the number of vertical fill "slices" a cell holds (LIQUID_MAX). Higher = smoother/finer vertical fill;
  // must stay ≤255 (Uint8). Changing it RESCALES all existing liquid (a full cell stays full) + re-broadcasts. Global
  // (coarse + fine); at 64 the coarse system is unchanged. Stratification (sortRate units/tick) is proportionally slower higher.
  cellCap: 24,
};
// DEBUG perf accounting (only touched when liquidCfg.perfLog): runLiquidTick tallies sim time + active cells and
// prints a rolling ~1s summary to the console. (emitLiquidCells, which centralised the coarse `liquid-cells` emit so
// its wire payload could be sized, went with that wire.)
let liqPerf = { simMs: 0, simMsMax: 0, active: 0, bytes: 0, ticks: 0, fineMs: 0, fineMsMax: 0, fineActive: 0, fineBytes: 0, fineChanged: 0 };
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
// (roomLiquidActive / roomLiquidAmt / roomLiquidTotal — the COARSE liquid state — were deleted with liquidTickRoom
//  on 2026-07-29. The roomFine* arrays are the liquid now.)
// FALL SIDE (per liquid cell): which edge a falling parcel spilled off — 0 none/settled · 1 hug LEFT · 2 hug RIGHT. Set
// from the spill direction on a down-diagonal, CARRIED straight down on a vertical fall, cleared on settle/empty. History
// the client render can't reconstruct from one frame → the sim owns it + broadcasts it. Pure annotation, never mass.
const SIDE_LEFT = 1, SIDE_RIGHT = 2;
// SECONDARY STREAM LANE (dual-stream chute): a 1-wide chute fed by streams from BOTH sides can't be one fall side, so a
// cell may carry a SECOND falling stream alongside the main one — its own liquid id + amount, hugging the opposite side.
// Only used for falling stream cells (rare); it falls independently and MERGES into the pool's main stack on landing.
// (roomStream2Amt / roomStream2Id — the s2 SECONDARY LANE, a coarse-only workaround letting two streams share one
//  scalar cell — went with the coarse sim. The fine grid resolves two streams by simply having enough cells.)
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
// Per-cell LEVELING carry (reduced-amount density throttle): holds the SUB-UNIT remainder of each throttled leveling move so
// a fractional per-tick amount still adds up to whole units over time (see `reduce` in liquidTickRoom). Sub-unit (<1/LIQUID_MAX
// of a cell) so it's never visible; seeded with a small per-cell phase so the invisible 1-unit fine steps don't all align.
const roomLevelAcc = {};
function ensureLevelAcc(room) { if (!roomLevelAcc[room]) { const a = new Float32Array(TERRAIN_COLS * TERRAIN_ROWS); for (let i = 0; i < a.length; i++) a[i] = ((Math.imul(i, 2654435761)) >>> 0) / 4294967296; roomLevelAcc[room] = a; } return roomLevelAcc[room]; }
// ── FINE-CELL LIQUID (experimental, gated by 1) — a parallel liquid grid at SUB× resolution, in SEPARATE
// arrays so the coarse system is UNTOUCHED. Same layout as the coarse arrays but sized FCOLS*FROWS. Terrain is read from
// the coarse grid via coarseOf() (map-on-read; the fine sim never writes terrain), and liquid lives only in these arrays.
const roomFineAmt = {}, roomFineTotal = {}, roomFineSide = {}, roomFineActive = {}, roomFineLevelAcc = {}, roomFineSub = {};
const roomFineStill = {};   // QUIESCENCE (fineQuiesce): per-fine-cell counter of consecutive ticks with no movement
// Wipe a room's liquid outright (world clear / scene load). The coarse version of this inlined five array fills at
// each call site; there is one grid now, so it is one helper.
function clearFineRoom(room) {
  if (roomFineAmt[room]) roomFineAmt[room].fill(0);
  if (roomFineTotal[room]) roomFineTotal[room].fill(0);
  if (roomFineSide[room]) roomFineSide[room].fill(0);
  if (roomFineActive[room]) roomFineActive[room].clear();
  if (roomFineReact[room]) roomFineReact[room].clear();
  if (roomFineFire[room]) roomFineFire[room].clear();
}
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
// ⭐ WAKE THE NEIGHBOURS of a cell whose stack was written from OUTSIDE the tick (placement, undo, a scene load).
// The density sort is only ever driven from the UPPER cell of a pair — processing a cell compares it with the cell
// BELOW — so dropping a lighter liquid under a settled heavier one activates the wrong half: the new cell has nothing
// to sort against below it, the cell above it is not active, and NOTHING happens. Measured: 2 cells of oil placed at
// the bottom of a settled water pool sat there forever, room quiet on the very next tick, with two genuine density
// inversions left standing. That is the "stuck slices" — and because the client spawns rise/sink bubbles for any
// sliver that is inverted with a neighbour, a permanently stuck inversion means the bubbles never stop.
function fineWakeAround(room, i) {
  const tot = roomFineTotal[room], grid = roomTerrain[room];
  if (!tot || !grid) return;
  const N = grid.length, COLS = TERRAIN_COLS, c = i % COLS, act = fineSet(room);
  for (const j of [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1]) {
    if (j < 0 || j >= N || tot[j] <= 0) continue;
    const v = grid[j]; if (v !== 0 && !isFluidId(v)) continue;
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
  const grid = roomTerrain[room], amt = roomFineAmt[room], tot = roomFineTotal[room];
  if (!grid || !amt || !tot || i < 0 || i >= grid.length) return false;
  const v = grid[i];
  if (v !== 0 && !isFluidId(v)) return false;          // a real solid owns this cell
  const id = tot[i] > 0 ? liqRepId(amt, i) : 0;
  if (v === id) return false;
  grid[i] = id; const hp = roomTerrainHp[room]; if (hp) hp[i] = 0;   // liquid is not diggable
  return true;
}
// Reaction amounts are FRACTIONS OF A CELL, resolved against the live capacity, so they keep meaning the same thing
// when cellCap is changed. Hard-coded unit counts were calibrated at cap 64 and silently became 2.7× stronger at 24.
const capFrac = (f) => { const v = Math.round(LIQUID_MAX * f); return v < 1 ? 1 : v; };
// scratch for the flux-levelling flood fill (reused per room so the pass allocates nothing per tick)
const roomFluxSeen = {}, roomFluxStack = {};
function ensureFluxSeen(room) { return roomFluxSeen[room] || (roomFluxSeen[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function ensureFluxStack(room) { return roomFluxStack[room] || (roomFluxStack[room] = new Int32Array(TERRAIN_COLS * TERRAIN_ROWS)); }
const roomFineFluxSeen = {}, roomFineFluxStack = {};   // fine-sized scratch for the fine flux-levelling pass (9× the coarse)
function ensureFineFluxSeen(room, cells) { const a = roomFineFluxSeen[room]; return (a && a.length === cells) ? a : (roomFineFluxSeen[room] = new Uint8Array(cells)); }
function ensureFineFluxStack(room, cells) { const a = roomFineFluxStack[room]; return (a && a.length === cells) ? a : (roomFineFluxStack[room] = new Int32Array(cells)); }
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
  const src = roomLiquidSrc[room]; if (!src || !src.size) return;
  sourceTickRoomFine(room, roomFineSub[room] || 1);
}
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
const SAT_MAX_F = 0.1875, SAT_ABSORB_F = 0.0625, SAT_DRY = 1, SAT_CLUMP_MIN = 3;   // low SAT_MAX: earth saturates fast + absorbs little water → flow barely slowed, pre-gen lakes barely shrink
function ensureSat(room) { return roomSat[room] || (roomSat[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
const roomSoilActive = {};                            // room → Set<cellIndex> of absorbent/wet solid cells worth ticking (earth/sand soaking, mud drying)
function soilSet(room) { return roomSoilActive[room] || (roomSoilActive[room] = new Set()); }
// Seed the soil set so soilTickRoom processes absorption/drying around water. Called on PAINT and at GEN (not just when a
// water cell happens to be "active") → placement + pre-generated lakes reliably + consistently start absorbing.
function seedSoilAround(room, grid, i) {
  const nn = grid.length, COLS = TERRAIN_COLS, c = i % COLS, N = [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];
  // In fine mode water is not a grid id — it is rank 4 of the fine stack — so both tests below have to read the fine
  // arrays or nothing is ever seeded and the whole saturation model stays asleep.
  const fine = (roomFineSub[room] || 1) === 1 && roomFineAmt[room];
  const famt = fine ? roomFineAmt[room] : null;
  const isWater = (j) => fine ? famt[j * LIQ_T + 4] > 0 : grid[j] === 9;
  const g = grid[i];
  if (isWater(i)) { const ss = soilSet(room); for (const j of N) { if (j < 0 || j >= nn) continue; const gj = grid[j]; if (gj === 1 || gj === 3 || gj === 5) ss.add(j); } }        // water → seed absorbent neighbours
  else if (g === 1 || g === 3 || g === 5) { for (const j of N) if (j >= 0 && j < nn && isWater(j)) { soilSet(room).add(i); return; } }                                            // absorbent solid placed by water → seed itself
}
// Set a cell to a single full-CAP liquid `id` (paint / gen / seed). Clears the other layers.
// Representative id (heaviest present) for grid[i], or 0 if the cell holds no liquid.
function liqRepId(amt, i) { const base = i * LIQ_T; for (let rk = 0; rk < LIQ_T; rk++) if (amt[base + rk] > 0) return LIQ_ID[rk]; return 0; }
// Wake + seed every cell in a rect after a terrain edit: a freshly PAINTED fluid becomes a full single-liquid stack, a
// CARVED-away fluid is cleared, and any surviving fluid is re-activated so it can flow.
function activateLiquidRect(room, grid, c0, r0, c1, r1) { fineActivateRect(room, grid, c0, r0, c1, r1); }
// After generation: every fluid grid cell becomes a full single-liquid stack + wakes (they settle in a few ticks).
// This used to fill the COARSE arrays and then call upscaleRoomToFine to hand them over, which at the all-fine ratio
// (one liquid cell per terrain cell) was a copy from an array to an identically-shaped array. It now seeds the fine
// grid directly. Same result, and it is what let upscaleRoomToFine/downscaleRoomToCoarse go.
function seedLiquidActivity(room) {
  const grid = roomTerrain[room]; if (!grid) return;
  ensureFineArrays(room, 1);
  const amt = roomFineAmt[room], tot = roomFineTotal[room], sd = roomFineSide[room], act = fineSet(room);
  amt.fill(0); tot.fill(0); sd.fill(0); act.clear();
  for (let i = 0; i < grid.length; i++) {
    if (!isFluidId(grid[i])) continue;
    amt[i * LIQ_T + LIQ_RANK[grid[i]]] = LIQUID_MAX; tot[i] = LIQUID_MAX;
    if (act.size < LIQUID_MAX_ACTIVE) act.add(i);
  }
  for (let i = 0; i < grid.length; i++) if (grid[i] === 9) seedSoilAround(room, grid, i);   // pre-generated lakes absorb just like poured water (no special-casing)
  if (!act.size) delete roomFineActive[room];
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
  const grid = roomTerrain[room], hp = roomTerrainHp[room], active = roomPowderActive[room];
  if (!grid || !hp || !active || !active.size) { if (active && !active.size) delete roomPowderActive[room]; return; }
  const mats = roomMats[room] || {}, T = LIQ_T, COLS = TERRAIN_COLS, tick = powderTickCount, nn = grid.length;
  const FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL);   // grains may not enter the bedrock floor row (same as liquid)
  // FINE mode: liquid lives in the roomFine* arrays and the terrain grid holds SOLIDS ONLY, so `isFluidId(grid[j])`
  // never matches and a grain read a liquid cell as plain AIR — it fell straight through the pool and, worse, the
  // grid[dst]===0 branch left the fine liquid sitting INSIDE the new solid cell. Same sink-and-swap logic, fine arrays.
  ensureFineArrays(room, 1);   // the fine arrays ARE the liquid; there is no coarse fallback to degrade to
  const famt = roomFineAmt[room], ftot = roomFineTotal[room], fsd = roomFineSide[room];
  const canDisplace = (j) => grid[j] === 0;   // liquid is not a grid id, so an empty grid cell covers a pool too
  const list = Array.from(active); active.clear();
  list.sort((a, b) => ((b / COLS) | 0) - ((a / COLS) | 0));   // bottom-up so a falling column cascades in a single pass
  const changedSet = new Set(), fineChanged = new Set();
  const wakeAround = (i) => { const c = i % COLS; for (const j of [i - COLS, c > 0 ? i - COLS - 1 : -1, c < COLS - 1 ? i - COLS + 1 : -1]) if (j >= 0 && isPowderId(grid[j])) active.add(j); };   // wake grains above the vacated cell → column keeps falling
  const swapMove = (src, dst) => {
    const P = grid[src], hpP = hp[src];
    {
      const bs = src * T, bd = dst * T;                      // src is solid ⇒ holds no fine liquid; dst may hold a pool
      const carried = ftot[dst];
      for (let k = 0; k < T; k++) { famt[bs + k] = famt[bd + k]; famt[bd + k] = 0; }   // the pool moves UP into the vacated cell
      ftot[src] = carried; ftot[dst] = 0; fsd[src] = 0; fsd[dst] = 0;
      grid[dst] = P; hp[dst] = hpP; grid[src] = 0; hp[src] = 0;
      fineSyncGrid(room, src);                               // the pool that moved up owns this cell now
      if (carried > 0) { fineSet(room).add(src); fineChanged.add(src); fineChanged.add(dst); }
      else fineChanged.add(dst);
      const sc = src % COLS; for (const j of [src - COLS, src + COLS, sc > 0 ? src - 1 : -1, sc < COLS - 1 ? src + 1 : -1]) if (j >= 0 && j < nn && ftot[j] > 0) fineSet(room).add(j);
    }
    changedSet.add(src); changedSet.add(dst); active.add(dst); wakeAround(src);
    if (liquidCfg.reactions) { seedFineReactAround(room, src); seedFineReactAround(room, dst); }   // a grain landing in a pool is a new contact (snow dropped into water → ice)
  };
  for (const i of list) {
    if (!isPowderId(grid[i])) continue;
    const r = (i / COLS) | 0, c = i - r * COLS; if (r + 1 >= FLOOR_ROW) continue;
    const below = i + COLS;
    if (canDisplace(below)) { swapMove(i, below); continue; }
    // DIAGONAL SLIDE — the grain must be able to pass THROUGH the side cell, not just land in the target. Checking only
    // the destination let a grain squeeze between two solids that touch only at their corners: it tunnelled through a
    // sealed diagonal crack, and in a pool it slipped past the ice it had just made and froze a diagonal trail behind it.
    for (const dc of (((i + tick) & 1) ? [-1, 1] : [1, -1])) {
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      if (!canDisplace(i + dc)) continue;                     // side blocked → no corner-cutting
      const j = below + dc; if (canDisplace(j)) { swapMove(i, j); break; }
    }
    // couldn't fall or slide → rests (not re-added to active)
  }
  {   // grain movement is a TERRAIN change; any pool it displaced rides the fine-liquid wire
    if (changedSet.size && !liquidQuiet) { const tc = []; for (const j of changedSet) tc.push(j, grid[j]); io.to(room).emit('terrain-set', { cells: tc }); }
    if (fineChanged.size && !liquidQuiet) emitFineCells(room, Array.from(fineChanged));
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
  const SAT_MAX = capFrac(SAT_MAX_F), SAT_ABSORB = capFrac(SAT_ABSORB_F);   // fractions of a cell → they track cellCap
  // ── SAME SATURATION LOGIC, FINE DATA SOURCE. In fine mode liquid lives in the roomFine* arrays and the terrain grid
  // holds solids only, so every `grid[j] === 9` water test and every coarse amt/tot read below found nothing and the
  // whole saturation model was inert (no earth→mud, no sand→quicksand, no drying). Only the ACCESSORS change here —
  // the model itself (SAT_MAX cell-by-cell, the wet-CLUMP rule for sand, drying, lava baking) is untouched.
  ensureFineArrays(room, 1);
  const lam = roomFineAmt[room], ltot = roomFineTotal[room], sd = roomFineSide[room];
  const changedSet = new Set(), fineChanged = new Set(), terrChanged = new Set(), fx = [];
  const addFx = (i, code) => { if (fx.length < 2048) fx.push(i, code); };   // same explicit FX wire as the reaction pass
  const isWater = (j) => lam[j * T + 4] > 0;   // water = rank 4
  const isLava = (j) => lam[j * T] > 0;
  const adj = (i, id) => { const c = i % COLS; if (i - COLS >= 0 && grid[i - COLS] === id) return true; if (i + COLS < nn && grid[i + COLS] === id) return true; if (c > 0 && grid[i - 1] === id) return true; if (c < COLS - 1 && grid[i + 1] === id) return true; return false; };
  const adjFn = (i, fn) => { const c = i % COLS; for (const j of [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1]) { if (j < 0 || j >= nn) continue; if (fn(j)) return true; } return false; };
  const adjWater = (i) => { const c = i % COLS; for (const j of [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1]) { if (j < 0 || j >= nn) continue; if (isWater(j)) return j; } return -1; };
  const wakeLiq = (j) => { if (j < 0 || j >= nn || ltot[j] <= 0) return; fineSet(room).add(j); };
  for (const i of Array.from(ss)) {
    const v = grid[i];
    // ABSORPTION (pull): earth/sand draw water out of an adjacent pool into their saturation, draining it. Only pull from a
    // SETTLED pool (wj not in the active/flowing set) → absorption never fights or slows the leveling of a still-flowing pool.
    if ((v === 1 || v === 3) && sat[i] < SAT_MAX) {
      const wj = adjWater(i);
      if (wj >= 0) {                                     // absorb even while the pool is still flowing — SAT_MAX is small enough now that it barely dents leveling
        const take = Math.min(SAT_ABSORB, SAT_MAX - sat[i], lam[wj * T + 4]);   // water = rank 4
        if (take > 0) {
          sat[i] += take; lam[wj * T + 4] -= take; ltot[wj] -= take;
          if (ltot[wj] <= 0) sd[wj] = 0;                                  // liquid was never in the grid
          fineChanged.add(wj); fineSet(room).add(wj); if (fineSyncGrid(room, wj)) terrChanged.add(wj);
          const wc = wj % COLS; wakeLiq(wj - COLS); wakeLiq(wj + COLS); if (wc > 0) wakeLiq(wj - 1); if (wc < COLS - 1) wakeLiq(wj + 1);   // re-level: the column above falls into the drained space (no hovering slivers)
        }
      }
    }
    if (v === 1) {                                       // EARTH → MUD once it has soaked up a cell's worth of water
      if (sat[i] >= SAT_MAX) { grid[i] = 5; hp[i] = matStrengthSrv(mats, 5); changedSet.add(i); terrChanged.add(i); addFx(i, 5); }   // mud splat   // stays tracked (mud dries later)
      else if (sat[i] === 0 && !adjFn(i, isWater)) ss.delete(i);
    } else if (v === 3) {                                // SAND → QUICKSAND, but only inside a wet CLUMP
      if (sat[i] >= SAT_MAX) {
        const r = (i / COLS) | 0, c = i - r * COLS; let clump = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || cc >= COLS) continue;
          const j = rr * COLS + cc; if (j < 0 || j >= nn) continue; const g = grid[j];
          if (g === 10 || (g === 3 && sat[j] >= SAT_MAX)) clump++;
        }
        if (clump >= SAT_CLUMP_MIN) {                    // sand becomes the QUICKSAND liquid: in fine mode that means a full fine cell, and the terrain cell empties
          { const b = i * T; for (let k = 0; k < T; k++) lam[b + k] = 0; lam[b + 1] = LIQUID_MAX; ltot[i] = LIQUID_MAX; sd[i] = 0; grid[i] = 10; hp[i] = 0; fineSet(room).add(i); fineChanged.add(i); terrChanged.add(i); }   // quicksand id back in the grid
          sat[i] = 0; changedSet.add(i); ss.delete(i);
        }
      } else if (sat[i] === 0 && !adjFn(i, isWater)) ss.delete(i);
    } else if (v === 5) {                                // MUD: lava bakes it dry instantly; water keeps it wet; else it dries → earth
      if (adjFn(i, isLava)) { grid[i] = 1; hp[i] = matStrengthSrv(mats, 1); sat[i] = 0; changedSet.add(i); terrChanged.add(i); addFx(i, 4); ss.delete(i); }   // baked dry: smoke
      else if (adjFn(i, isWater)) sat[i] = SAT_MAX;
      else { sat[i] = sat[i] > SAT_DRY ? sat[i] - SAT_DRY : 0; if (sat[i] === 0) { grid[i] = 1; hp[i] = matStrengthSrv(mats, 1); changedSet.add(i); terrChanged.add(i); addFx(i, 6); ss.delete(i); } }   // dried out: dust puff
    } else { sat[i] = 0; ss.delete(i); }                 // cell dug/overwritten out from under us
  }
  // terrain conversions ride terrain-set; drained/created liquid rides the fine wire
  if (fx.length && !liquidQuiet) io.to(room).emit('liquid-fx', { cells: fx });
  if (terrChanged.size && !liquidQuiet) { const tc = []; for (const j of terrChanged) tc.push(j, grid[j]); io.to(room).emit('terrain-set', { cells: tc }); }
  if (fineChanged.size && !liquidQuiet) emitFineCells(room, Array.from(fineChanged));
  if (liquidCfg.reactions) { const rs = fineReactSet(room); for (const j of terrChanged) rs.add(j); for (const j of fineChanged) rs.add(j); }
  if (!ss.size) delete roomSoilActive[room];
}
// ── FINE-CELL LIQUID TICK ── the coarse multi-liquid CORE FLOW (density sorts 2/2b · straight-down 1a · ledge spill 1b ·
// lateral levelling 1c/1d · per-liquid levelling 2c · fallSide tag), reproduced at SUB× resolution in the roomFine* arrays.
// Solids are read from the coarse terrain via coarseOf() (map-on-read, no terrain mirror; NEVER writes terrain). DROPLETS,
// REACTIONS, SINKS, the secondary lane and flux levelling are OMITTED (inc 1 = pipeline; reactions come next). Honours the
// same liquidCfg flags so behaviour matches. PROVEN faithful by the harness SUB=1 identity test (fineLiquidTickRoom(room,1)
// == liquidTickRoom with droplets+reactions off, on reaction-free scenes).
function fineLiquidTickRoom(room, SUB) {
  SUB = SUB || roomFineSub[room] || 1;
  const grid = roomTerrain[room], amt = roomFineAmt[room], tot = roomFineTotal[room], active = roomFineActive[room];
  if (!grid || !amt || !tot || !active || !active.size) { if (active && !active.size) delete roomFineActive[room]; return; }
  const sd = roomFineSide[room], lvlAcc = roomFineLevelAcc[room];
  const tick = liquidTickCount, cap = LIQUID_MAX, T = LIQ_T;
  const COLS = TERRAIN_COLS * SUB, FROWS = TERRAIN_ROWS * SUB, NCELL = COLS * FROWS;
  const LIQUID_FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL) * SUB;   // liquid may not descend into/below the bedrock row (scaled to fine rows)
  const SCAN = LIQUID_LEVEL_SCAN * SUB;                                  // levelling scan reach in CELLS → scaled so PHYSICAL reach is unchanged
  const coarseOf = (k) => { const fr = (k / COLS) | 0, fc = k - fr * COLS; return ((fr / SUB) | 0) * TERRAIN_COLS + ((fc / SUB) | 0); };
  const isSolid = (k) => { if (k < 0 || k >= NCELL) return true; const v = grid[coarseOf(k)]; return v !== 0 && !isFluidId(v); };   // fine solid = the coarse terrain cell it sits in
  const isSinkF = (k) => { if (k < 0 || k >= NCELL) return false; return isSinkId(grid[coarseOf(k)]); };   // a fine cell whose coarse cell is a DRAIN block
  const sinkRate = Math.max(0, Math.min(cap, liquidCfg.sinkRate | 0)), sinkLed = sinkLedger(room);
  const changedSet = new Set(), tagCleared = new Set(), airborneWire = new Set();   // accumulate across the physics sub-steps below; broadcast once
  // QUIESCENCE scratch (only when enabled): per-fine-cell counter of consecutive ticks the cell did NOT move. Reallocated if NCELL changed (sub switch).
  const quiesce = liquidCfg.fineQuiesce ? ((roomFineStill[room] && roomFineStill[room].length === NCELL) ? roomFineStill[room] : (roomFineStill[room] = new Uint16Array(NCELL))) : null;
  let stepMoves = 0;   // cell-changes in the current sub-step (adaptive-K activity proxy)
  const wake = (j) => { if (j >= 0 && j < NCELL && !isSolid(j) && tot[j] > 0) active.add(j); };
  const wakeN = (j) => { const x = j % COLS; wake(j - COLS); wake(j + COLS); if (x > 0) wake(j - 1); if (x < COLS - 1) wake(j + 1); };
  const wakeD = (j) => { wakeN(j); const x = j % COLS; if (x > 0) { wake(j - COLS - 1); wake(j + COLS - 1); } if (x < COLS - 1) { wake(j - COLS + 1); wake(j + COLS + 1); } };
  const mark = (j) => { changedSet.add(j); active.add(j); stepMoves++; };
  const recomp = (j) => { let s = 0, b = j * T; for (let k = 0; k < T; k++) s += amt[b + k]; tot[j] = s; };
  const moveBottom = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const moveTop = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = T - 1; rk >= 0 && need > 0; rk--) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const moveProp = (A, B, t) => { const ba = A * T, bb = B * T, TA = tot[A]; if (TA <= 0 || t <= 0) return 0; let need = t, moved = 0;
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; let mv = Math.round(t * a / TA); if (mv > a) mv = a; if (mv > need) mv = need; if (mv <= 0) continue; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }
    if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const floorRank = (j) => { const b = j * T; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) return rk; return -1; };
  const ceilRank = (j) => { const b = j * T; for (let rk = T - 1; rk >= 0; rk--) if (amt[b + rk] > 0) return rk; return -1; };
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
    const la = amt[A * T] > 0, lb = amt[B * T] > 0;
    if (!la && !lb) return false;
    return (la && tot[B] - amt[B * T] > 0) || (lb && tot[A] - amt[A * T] > 0);
  };
  // ⭐⭐ WOULD THE DENSITY SORT FIRE FOR THIS CELL RIGHT NOW? Mirrors (2) and (2b) below exactly, minus the per-sub-step
  // budget — used to keep a still-inverted cell in the ACTIVE SET when that budget has turned the sort off. Keep the
  // three in step: if a gate is added to (2)/(2b), add it here too, or a pair it blocks will spin in `active` forever.
  const wouldSort = (i, r, c) => {
    if (!liquidCfg.densitySort) return false;
    if (liquidCfg.streamNoSort && liquidCfg.streamTag && sd[i] !== 0) return false;   // noSortStream
    if (r + 1 >= LIQUID_FLOOR_ROW) return false;                                      // canDown
    const hi = floorRank(i); if (hi < 0) return false;
    const nbr = liquidCfg.streamNoSortNbr && liquidCfg.streamTag;
    for (const j of [i + COLS, c > 0 ? i + COLS - 1 : -1, c < COLS - 1 ? i + COLS + 1 : -1]) {
      if (j < 0 || j >= NCELL || tot[j] <= 0 || isSolid(j)) continue;
      if (nbr && sd[j] !== 0) continue;
      if (lavaBlk(i, j)) continue;
      if (hi < ceilRank(j)) return true;     // the sim's own swap rule: floorRank(above) < ceilRank(below)
    }
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
  const NSTEPS = Math.max(FSTEPS, FALLSTEPS), ADAPT_PCT = Math.max(1, Math.min(50, liquidCfg.fineAdaptPct | 0));
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
  for (let step = 0; step < NSTEPS; step++) {
    if (!active.size) break;
    const doFall = step < FALLSTEPS;    // this sub-step runs the vertical descent (1a straight-down, 1b ledge spill)
    const doLevel = step < FSTEPS;      // this sub-step runs lateral levelling (1c/1d/2c)
    const doSort = step < SORTSTEPS;    // this sub-step runs the DENSITY SORT (2/2b) — capped separately so sorting can be slowed independently of levelling
    const doSortDiag = step < DIAGSTEPS; // ...and the DIAGONAL half (2b) is capped tighter still, to bound sideways travel
    const doPerLiq = step < PLSTEPS;    // (2c) per-liquid levelling — capped separately: this IS its sideways spread speed in cells/tick
    stepMoves = 0;
    const list = Array.from(active); active.clear();
    list.sort((a, b) => { const ra = (a / COLS) | 0, rb = (b / COLS) | 0; if (ra !== rb) return rb - ra; const la = tot[a], lb = tot[b]; if (la !== lb) return la - lb; return (tick & 1) ? a - b : b - a; });
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
    const colStillSorting = (cc) => {
      let v = colSorting.get(cc);
      if (v !== undefined) return v;
      v = false;
      for (let r2 = 0; r2 + 1 < FROWS; r2++) {
        const a2 = r2 * COLS + cc, b2 = a2 + COLS;
        if (tot[a2] <= 0 || tot[b2] <= 0 || isSolid(a2) || isSolid(b2)) continue;
        const f = floorRank(a2); if (f >= 0 && f < ceilRank(b2)) { v = true; break; }
      }
      colSorting.set(cc, v); return v;
    };
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
    // SORT BEFORE LEVEL (liquidCfg.sortBeforeLevel): a cell that ACTUALLY swapped this sub-step does not also spread
    // sideways. Without it a dropped mixed blob sorts and races outward at the same time, which reads as unrealistic
    // and fires sink/rise bubble FX across the whole width at once. Set only when a swap really happened — a sort that
    // is merely BLOCKED (stream tag, lavaBlk) must not freeze levelling, or that cell would never settle at all.
    let sortedHere = false;
    // (2) density sort with the cell BELOW
    if (doSort && liquidCfg.densitySort && !noSortStream && canDown && tot[i + COLS] > 0 && !isSolid(i + COLS) && !(noSortNbr && sd[i + COLS] !== 0) && !lavaBlk(i, i + COLS)
        && !(liquidCfg.fineSortOnePerPass && sortedTo.has(i + COLS))) {
      const j = i + COLS, hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); if (k > 0) { sortedHere = true; sortedTo.add(i); } }
    }
    // (2b) diagonal density sort — see fineSortDiagGate/fineSortDiagSteps. `sortedHere` is set by (2) directly above,
    // so gating on it means "the straight-up swap already handled this cell, don't ALSO shove it sideways".
    if (doSort && doSortDiag && liquidCfg.densitySort && !noSortStream && canDown && !(liquidCfg.fineSortDiagGate && sortedHere))
      for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) {
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      const j = i + COLS + dc; if (isSolid(j) || tot[j] === 0) continue;
      if (noSortNbr && sd[j] !== 0) continue;
      if (lavaBlk(i, j)) continue;
      if (liquidCfg.fineSortOnePerPass && sortedTo.has(j)) continue;
      const hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); if (k > 0) { sortedHere = true; sortedTo.add(i); } break; }
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
    if (!doSort && wouldSort(i, r, c)) active.add(i);
    // (1a) straight down (tag carried only onto air / an already-falling cell). Gated on doFall so the fall rate can be
    // held constant regardless of the levelling sub-step count (fineConstFall).
    if (doFall && canDown) { const j = i + COLS; const room2 = cap - tot[j]; if (!isSolid(j) && room2 > 0 && !lavaBlk(i, j)) { let t = Math.min(L, room2); if (MINU > 1) t -= t % MINU; if (t > 0) { const wasAirJ = tot[j] === 0; moveBottom(i, j, t); if (liquidCfg.streamTag && sd[i] !== 0 && (wasAirJ || fell.has(j))) sd[j] = sd[i]; L -= t; wakeN(i); } } }
    // density throttle (viscosity off by default → lf=1 → reduce is a pass-through)
    const cr = ceilRank(i), lf = (liquidCfg.viscosity && cr >= 0) ? 1 / (1 + LEVEL_VISC[cr]) : 1;
    let pend = false;
    const reduce = (want) => { if (want <= 0) return 0; if (lf >= 1) return want; lvlAcc[i] += want * lf; let mv = lvlAcc[i] | 0; if (mv > want) mv = want; lvlAcc[i] -= mv; if (mv <= 0) pend = true; return mv; };
    // (1b) ledge spill — plain (no chute/secondary-lane, no droplet cascade), with the mid-air support guard. Gated on
    // fineLedge: OFF ⇒ skip it and let 1c move liquid into the edge cell + 1a drop it (same result, one tick slower).
    if (doFall && liquidCfg.ledgeSpill && liquidCfg.fineLedge && L > 0 && canDown && (isSolid(i + COLS) || tot[i + COLS] >= cap)) for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { if (L <= 0) break; const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + COLS + dc; if (isSolid(j) || lavaBlk(i, j)) continue;
      if (!isSolid(i + COLS)) { const jb = j + COLS; const jSupported = ((j / COLS) | 0) + 1 >= LIQUID_FLOOR_ROW || isSolid(jb) || tot[jb] > 0; if (!jSupported) continue; }
      if (tot[j] < cap) { const t = reduce(Math.min(L, cap - tot[j])); const ns = dc > 0 ? SIDE_LEFT : SIDE_RIGHT;
        const tagOk = !liquidCfg.streamTag || (isSolid(i + COLS) && (tot[j] === 0 || fell.has(j)));
        if (t > 0) { (liquidCfg.streamMix ? moveProp : moveBottom)(i, j, t); if (tagOk) sd[j] = ns; L -= t; wakeN(i); } }
    }
    // STILL SORTING? Evaluated with the same test the sort itself uses, AFTER it has run this sub-step. Gating on
    // "a swap happened" alone was far too weak (measured: no effect at all) — the swap resolves in sub-step 0 and the
    // cell then levels through the remaining K-1 sub-steps while its neighbours are still separating. A cell that is
    // still density-inverted with the cell below or either diagonal has NOT finished, so it must not spread yet.
    // STILL SORTING? Gated per COLUMN, not per pair. A per-pair test measured as a no-op: at K=9 sub-steps each
    // adjacent pair re-sorts within a tick, so it fired on 36 cells at t0 and 7 by t4 while levelling ran on 300+.
    // What actually takes 10+ ticks is the BODY rearranging (heavy migrating to the bottom), during which any given
    // pair is momentarily in order. So: while this column holds ANY vertical inversion it is still separating, and
    // none of its cells may spread sideways yet.
    const sortingHere = liquidCfg.sortBeforeLevel && (sortedHere || (liquidCfg.densitySort && colStillSorting(c)));
    const roomAt = (j) => !isSolid(j) && tot[j] < cap;
    const canFall = canDown && (roomAt(i + COLS) || fell.has(i + COLS) || (c > 0 && roomAt(i + COLS - 1)) || (c < COLS - 1 && roomAt(i + COLS + 1)));
    if (canFall) fell.add(i);
    const airborne = canDown && (roomAt(i + COLS) || fellDown.has(i + COLS));
    // A cell that still has room to fall must NEVER leave the active set. With fineConstFall on, the descent runs in
    // sub-step 0 only; sub-steps 1..K-1 then process an airborne cell that can neither fall (doFall off) nor level
    // (gated off for a stream), so nothing mark()s it, `active` drains to empty and the room is dropped — a lone parcel
    // freezes in mid-air exactly one cell below where it was placed. A continuous stream hid this because the cell above
    // re-wakes it every tick. Self-limiting: once it lands, roomAt(below) is false ⇒ not airborne ⇒ it settles normally.
    // ...but only while a fall is genuinely still possible. fineMinUnit quantises the descent, so a sub-unit remainder
    // can never move; keeping THAT active spins forever (it never settles, which the mitigations probe caught).
    const belowRoom = (canDown && !isSolid(i + COLS)) ? cap - tot[i + COLS] : 0;
    const keepFalling = belowRoom > 0 && L > 0 && (MINU <= 1 || (L < belowRoom ? L : belowRoom) >= MINU);
    if (airborne) { fellDown.add(i); airborneWire.add(i); if (keepFalling) active.add(i); }
    if (!canFall) { if (liquidCfg.streamTag && sd[i] !== 0) { sd[i] = 0; tagCleared.add(i); } }
    const isStream = liquidCfg.levelGate === 0 ? canFall
                   : liquidCfg.levelGate === 3 ? (sd[i] !== 0 || airborne)
                   : liquidCfg.levelGate === 2 ? (sd[i] !== 0)
                   : (sd[i] !== 0 || (canDown && roomAt(i + COLS)));
    const shedCap = L;
    if (doLevel && !isStream && !sortingHere) {
      const cumAt = (jj, tt) => { let s = 0; const bb = jj * T; for (let k = 0; k <= tt; k++) s += amt[bb + k]; return s; };
      // (2c) per-liquid horizontal levelling (pools only). MEASURED to be what spreads a parcel sideways: it runs on
      // every sub-step and looks SCAN cells along the row, so a 3-column blob films across a whole pool in one tick.
      // PLSTEPS caps how many sub-steps it may run in (= its spread speed) and PLSCAN how far it looks; both default
      // to the original values, so this is unchanged until the dials are turned down.
      if (liquidCfg.perLiquidLevel && doPerLiq) for (let t = 0; t < T - 1; t++) {
        if (amt[i * T + t] <= 0) continue;
        const Ci = cumAt(i, t);
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= PLSCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j2 = i + sdir * d; if (isSolid(j2)) break; const Cj = cumAt(j2, t); if (Cj > Ci) break; if (Cj <= Ci - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir === 0) continue;
        const j = i + dir; if (isSolid(j) || lavaBlk(i, j)) continue;
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
        if (liquidCfg.finePerLiquidSortGate && liquidCfg.densitySort && colStillSorting(c + dir)) continue;
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
          const okL = jL >= 0 && !isSolid(jL) && L - tot[jL] > 1 && !lavaBlk(i, jL);
          const okR = jR >= 0 && !isSolid(jR) && L - tot[jR] > 1 && !lavaBlk(i, jR);
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
        } else for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + dc; if (isSolid(j) || lavaBlk(i, j)) continue; const nl = tot[j], room2 = cap - nl; if (L - nl > 1 && room2 > 0) { const mv = Math.min(reduce(Math.min((L - nl) >> 1, room2)), shedCap); if (mv > 0) { lvlMove(i, j, mv); sd[j] = 0; L -= mv; wakeN(i); } } }
      }
      // (1d) surface flat-settle — capped to FLATSTEPS of the K sub-steps (see the budget above). Uncapped it runs
      // every sub-step, and because an EMPTY neighbour always counts as "lower", the leading edge of a puddle sheds
      // onward every time: the front advanced ~9 cells/tick and raced away from the body that was still separating.
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 0 && step < FLATSTEPS) {
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= SCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j = i + sdir * d; if (isSolid(j)) break; const jl = tot[j]; if (jl > L) break; if (jl <= L - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir !== 0 && shedCap >= 1) { const j = i + dir; if (tot[j] < L && tot[j] < cap && !lavaBlk(i, j) && reduce(1) > 0) { lvlMove(i, j, 1); sd[j] = 0; L -= 1; wakeN(i); } }
      }
    }
    if (pend) active.add(i);
    if (changedSet.has(i)) wakeN(i);
  }
  // ═══ FLUX LEVELLING (liquidCfg.fluxLevel) at fine res — "global target, LOCAL transport" (ported from the coarse sim).
  // Off by default (1c/1d handle levelling); on = per-body equilibrium waterline + prefix-sum interface fluxes moved at a
  // bounded rate BETWEEN ADJACENT cells only. Faster on wide pools; shelved for its sliding-slab look + it levels streams
  // it absorbs. Behind the same toggle so it can be A/B'd on the fine grid. No secondary lane here (fine has none).
  if (liquidCfg.fluxLevel) {
    const ROWS = TERRAIN_ROWS * SUB, NCELL2 = COLS * ROWS, RATE = liquidCfg.fluxRate | 0;
    const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
    const seen = ensureFineFluxSeen(room, NCELL2); seen.fill(0);
    const stack = ensureFineFluxStack(room, NCELL2);
    const cFloor = new Int32Array(COLS), cTop = new Int32Array(COLS), cH = new Float64Array(COLS);
    for (let start = 0; start < NCELL2; start++) {
      if (seen[start] || isSolid(start) || tot[start] <= 0) continue;
      let sp = 0; stack[sp++] = start; seen[start] = 1;
      let minC = COLS, maxC = -1;
      while (sp > 0) {
        const j = stack[--sp], jc = j % COLS;
        if (jc < minC) minC = jc; if (jc > maxC) maxC = jc;
        const jr = (j / COLS) | 0;
        if (jc > 0) { const k = j - 1; if (!seen[k] && !isSolid(k) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jc < COLS - 1) { const k = j + 1; if (!seen[k] && !isSolid(k) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jr > 0) { const k = j - COLS; if (!seen[k] && !isSolid(k) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jr < ROWS - 1) { const k = j + COLS; if (!seen[k] && !isSolid(k) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
      }
      if (maxC <= minC) continue;
      const cols = [], part = new Uint8Array(COLS);
      for (let c = minC; c <= maxC; c++) {
        let r = -1;
        for (let rr = ROWS - 1; rr >= 0; rr--) { const j = rr * COLS + c; if (seen[j] && tot[j] > 0) { r = rr; break; } }
        if (r < 0) continue;
        while (r + 1 < ROWS && r + 1 < LIQUID_FLOOR_ROW && !isSolid((r + 1) * COLS + c)) r++;
        const fl = r + 1;
        let t = fl; while (t - 1 >= 0 && !isSolid((t - 1) * COLS + c) && tot[(t - 1) * COLS + c] >= cap) t--;
        if (t - 1 >= 0 && !isSolid((t - 1) * COLS + c)) { const v = tot[(t - 1) * COLS + c]; if (v > 0 && v < cap && sd[(t - 1) * COLS + c] === 0) t--; }
        if (t >= fl) continue;
        let h = 0; for (let rr = t; rr < fl; rr++) h += tot[rr * COLS + c];
        let cl = t; while (cl - 1 >= 0 && !isSolid((cl - 1) * COLS + c) && tot[(cl - 1) * COLS + c] <= 0) cl--;
        cFloor[c] = fl; cTop[c] = cl; cH[c] = h; part[c] = 1; cols.push(c);
      }
      if (cols.length < 2) continue;
      const barrier = (c) => part[c] && cTop[c] > 0 && isSolid((cTop[c] - 1) * COLS + c) && cH[c] >= (cFloor[c] - cTop[c]) * cap - 1;
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
            while (sr < cFloor[src] && (isSolid(sr * COLS + src) || tot[sr * COLS + src] <= 0)) sr++;
            if (sr >= cFloor[src]) break;
            while (dr >= cTop[dst] && (isSolid(dr * COLS + dst) || cap - tot[dr * COLS + dst] <= 0)) dr--;
            if (dr < cTop[dst] || dr < sr) break;
            const A = sr * COLS + src, B = dr * COLS + dst; if (A === B || lavaBlk(A, B)) break;
            const mv = Math.min(tot[A], cap - tot[B], need); if (mv <= 0) break;
            const did = lvlMove(A, B, mv); if (did <= 0) break;
            sd[B] = 0; need -= did; wakeN(A); wakeN(B);
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
  for (const j of tagCleared) changedSet.add(j);
  // Keep the grid's representative fluid id in step with every cell that moved (see fineSyncGrid).
  for (const j of changedSet) fineSyncGrid(room, j);
  if (changedSet.size && !liquidQuiet) {
    if (liquidCfg.perfLog) liqPerf.fineChanged += changedSet.size;
    // WIRE (liquid-fine-cells): sub + cols so the client can decode fine indices, then per changed cell
    // [index, repId, side(low2=fallSide, 0x40=airborne), mask] followed by one amt per set rank bit.
    let arr = [], cells = 0;
    const emitFine = () => { if (liquidCfg.perfLog && arr.length) liqPerf.fineBytes += JSON.stringify(arr).length + 24; io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr }); };
    for (const j of changedSet) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      arr.push(j, liqRepId(amt, j), (sd[j] & 0x03) | (airborneWire.has(j) ? 0x40 : 0), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
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
    if (isSolid(j) || tot[j] <= 0) { active.delete(j); continue; }
    // ⚠️ Quiescence's whole safety argument is "an inverting cell is marked by the sort every tick, so it can never
    // freeze mid-stratification". `fineSortOnePerPass` breaks that premise: a pair whose swap was BLOCKED this pass
    // (the cell below already received liquid) never moves, so it is absent from changedSet and was frozen while still
    // inverted — 4 rest inversions, exactly the failure quiescence was designed to avoid. Ask the sort directly.
    if (quiesce) { if (changedSet.has(j) || wouldSort(j, (j / COLS) | 0, j % COLS)) quiesce[j] = 0; else if (++quiesce[j] >= QT) active.delete(j); }
  }
  if (!active.size) delete roomFineActive[room];
}
// ══ FINE REACTIONS (all-fine terrain) ═══════════════════════════════════════════════════════════════════════════════
// In all-fine mode the liquid grid and the TERRAIN grid are the same 8px cells (SUB=1 ⇒ a fine index IS a grid index), so
// a reaction is CELL-BY-CELL and IMMEDIATE ON CONTACT: lava and water make one 8px stone cell exactly where they meet and
// never spend a tick coexisting. That is the whole point of going all-fine — the coarse-window accumulator it replaces
// ("B-i") could only ever approximate it and is deliberately NOT reintroduced. Runs BEFORE fineLiquidTickRoom, which
// consumes the active set (see the call site). Writes terrain (grid+hp) directly and broadcasts over the existing
// `terrain-set` + `liquid-fine-cells` wires — both already handled client-side, so this is a server-only change.
const roomFineReact = {};    // room → Set<fine cell> explicitly seeded for a reaction test (see seedFineReactAround)
function fineReactSet(room) { return roomFineReact[room] || (roomFineReact[room] = new Set()); }
// A reaction can only START when something changes, and anything that moved is already in roomFineActive — which the tick
// uses as its candidate list. What that misses is a change to a SETTLED pair (painting water beside a settled lava pool,
// digging the wall between them), so terrain edits seed the cell + its 4 neighbours explicitly.
function seedFineReactAround(room, i) {
  if (!liquidCfg.reactions) return;
  const COLS = TERRAIN_COLS, N = COLS * TERRAIN_ROWS; if (i < 0 || i >= N) return;
  const s = fineReactSet(room), c = i % COLS;
  s.add(i); if (i - COLS >= 0) s.add(i - COLS); if (i + COLS < N) s.add(i + COLS);
  if (c > 0) s.add(i - 1); if (c < COLS - 1) s.add(i + 1);
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
// ACID at 8px. The coarse bite was one 24px cell per 8 ticks = 3px of penetration per tick; an 8px cell eaten at the
// same cadence would only be 1px/tick, i.e. 3× slower through the same wall. Biting every 3rd tick restores the
// original physical eat-rate — the reaction is unchanged, only the cadence is re-derived for the smaller cell.
const ACID_BITE_TICKS = 3;
const FREACT_ACID_COST_F = 0.09375; // acid spent per bite
// OIL FIRE. Lava does not burn oil directly any more — it IGNITES it, and fire spreads cell to cell through the oil,
// so a slick lights from the point of contact and runs back through itself instead of quietly shrinking.
const roomFineFire = {};     // room → Set<fine cell> currently burning
function fineFireSet(room) { return roomFineFire[room] || (roomFineFire[room] = new Set()); }
function fineReactTickRoom(room, SUB) {
  if (!liquidCfg.reactions) return;
  SUB = SUB || roomFineSub[room] || 1;
  if (SUB !== 1) return;     // reactions write TERRAIN; the two grids only share an index space at the all-fine ratio
  const grid = roomTerrain[room], hp = roomTerrainHp[room], amt = roomFineAmt[room], tot = roomFineTotal[room];
  if (!grid || !hp || !amt || !tot) return;
  const active = roomFineActive[room], seeded = roomFineReact[room], burning = roomFineFire[room];
  if ((!active || !active.size) && (!seeded || !seeded.size) && (!burning || !burning.size)) { if (seeded) delete roomFineReact[room]; return; }
  const sd = roomFineSide[room], mats = roomMats[room] || {}, T = LIQ_T, COLS = TERRAIN_COLS, N = grid.length;
  const tick = liquidTickCount, FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL);   // acid may not eat the bedrock row
  const act = fineSet(room), liqChanged = new Set(), terrCells = [], fx = [];
  // FX WIRE. The client used to derive reaction FX from grid TRANSITIONS on the coarse liquid-cells wire (`old === 11
  // && gid === 2` ⇒ steam, etc). In fine mode liquid is not a grid id at all, so no transition can ever match and every
  // one of those effects is unreachable. The server knows exactly which reaction fired, so it says so: [cell, code].
  const addFx = (i, code) => { if (fx.length < 4096) fx.push(i, code); };
  const wake = (j) => { if (j >= 0 && j < N && tot[j] > 0) { const v = grid[j]; if (v === 0 || isFluidId(v)) act.add(j); } };
  const wakeN = (j) => { const c = j % COLS; wake(j - COLS); wake(j + COLS); if (c > 0) wake(j - 1); if (c < COLS - 1) wake(j + 1); };
  const recomp = (j) => { let s = 0; const b = j * T; for (let k = 0; k < T; k++) s += amt[b + k]; tot[j] = s; };
  const clearFine = (j) => { const b = j * T; for (let k = 0; k < T; k++) amt[b + k] = 0; tot[j] = 0; sd[j] = 0; act.delete(j); liqChanged.add(j); };
  // A reaction product that is SOLID: takes the cell whole (any liquid in it goes with it) and rides the terrain wire.
  const setSolid = (j, id) => { if (tot[j] > 0 || sd[j]) clearFine(j); act.delete(j); grid[j] = id; hp[j] = matStrengthSrv(mats, id); terrCells.push(j, id); if (roomSat[room]) roomSat[room][j] = 0; wakeN(j); };
  // ...and one that is LIQUID: the solid is removed from terrain and the liquid appears in the same cell (in fine mode
  // terrain holds solids only, so a melt is BOTH a terrain-set to empty and a fine-liquid write).
  const setLiquid = (j, rk, units) => {
    grid[j] = 0; hp[j] = 0; terrCells.push(j, 0);
    const jb = j * T; for (let k = 0; k < T; k++) amt[jb + k] = 0;
    amt[jb + rk] = units; tot[j] = units; sd[j] = 0;
    liqChanged.add(j); act.add(j); wakeN(j);
    const up = j - COLS; if (up >= 0 && isPowderId(grid[up])) powderSet(room).add(up);   // grains resting on the melted cell may now fall
  };
  const spendLava = (i, cost) => { const b = i * T; amt[b] = amt[b] > cost ? amt[b] - cost : 0; recomp(i); liqChanged.add(i); if (tot[i] > 0) act.add(i); else act.delete(i); wakeN(i); return amt[b]; };
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
    const prod = (bc === a + COLS) ? bc : (a === bc + COLS ? a : (isSolidCell(grid[bc]) ? bc : a));
    const gone = prod === a ? bc : a;
    if (grid[gone] !== 0) { grid[gone] = 0; hp[gone] = 0; terrCells.push(gone, 0); wakeN(gone); }
    if (tot[gone] > 0) clearFine(gone);
    setSolid(prod, id); if (code) addFx(prod, code);
  };
  // Candidates: every cell that moved this tick, plus anything seeded by a terrain edit. The reaction is anchored on the
  // LAVA cell, which may be a candidate itself OR a settled neighbour of one (a still lava pool a stream just reached),
  // so each candidate also offers up its 4 neighbours — `done` keeps a shared lava cell from being evaluated twice.
  const cand = [];
  if (active) for (const i of active) cand.push(i);
  if (seeded) { for (const i of seeded) cand.push(i); seeded.clear(); }
  const seen = new Set(), anchors = [];
  for (const ci of cand) {
    if (ci < 0 || ci >= N) continue;
    const cc = ci % COLS;
    for (const i of [ci, ci - COLS, ci + COLS, cc > 0 ? ci - 1 : -1, cc < COLS - 1 ? ci + 1 : -1]) {
      if (i < 0 || i >= N || seen.has(i)) continue;
      seen.add(i); anchors.push(i);
    }
  }
  // ⭐ TWO PHASES, so the result cannot depend on Set iteration order. EVERY lava contact is resolved first, then the
  // water-freezing is evaluated against the state that leaves. Measured before the split: the same lava-on-snow setup
  // gave STONE in one geometry and ICE in another, purely on which cell the pass happened to reach first.
  for (const i of anchors) {
      const b = i * T, c = i % COLS;                          // ranks: lava0 quicksand1 brine2 acid3 water4 oil5
      if (amt[b] <= 0) continue;
      const NB = [i + COLS, i - COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];   // BELOW first: lava resting on a pool crusts INTO it, not one cell above
      // ── (A) SOLID terrain the lava is touching. Each conversion costs lava, so a pool eats a bounded distance in.
      for (const j of NB) {
        if (amt[b] <= 0 || j < 0 || j >= N) continue;
        const g = grid[j];
        if (g === 8 || g === 4) { setLiquid(j, 4, capFrac(FREACT_MELT_AMT_F)); spendLava(i, capFrac(FREACT_MELT_COST_F)); addFx(j, 1); }   // snow/ice melt → water
        else if (g === 5) { setSolid(j, 1); spendLava(i, capFrac(FREACT_BAKE_COST_F)); addFx(j, 4); }                          // mud baked dry → earth
        else if (g === 3) { convertSolid(j, 16, 3); spendLava(i, capFrac(FREACT_FUSE_COST_F)); }                                                       // sand fused → glass, BOTH consumed
      }
      if (amt[b] <= 0) continue;                              // the lava spent itself on the terrain
      // ── (B) QUICKSAND fuses to GLASS. Checked before the quench so it wins over the generic crust.
      let qj = amt[b + 1] > 0 ? i : -1;
      if (qj < 0) for (const j of NB) { if (j >= 0 && j < N && amt[j * T + 1] > 0) { qj = j; break; } }
      if (qj >= 0) {
        if (qj === i) { setSolid(i, 16); addFx(i, 3); continue; }           // mixed in one cell → that cell is the glass
        combine(i, qj, 16, 3); continue;                          // both consumed
      }
      // ── (C) QUENCH → STONE. Brine, acid and water all crust lava.
      let wj = -1;
      for (const rk of [2, 3, 4]) if (amt[b + rk] > 0) { wj = i; break; }   // mixed into this very cell counts as contact
      if (wj < 0) for (const j of NB) { if (j < 0 || j >= N || tot[j] <= 0) continue; const jb = j * T;
        if (amt[jb + 2] > 0 || amt[jb + 3] > 0 || amt[jb + 4] > 0) { wj = j; break; } }
      if (wj >= 0) {
        const sj = (wj === i + COLS) ? wj : i, pj = sj === i ? wj : i;      // the stone takes the LOWER cell; tie ⇒ the lava cell
        if (sj !== pj) {
          if (pj === i) { amt[b] = 0; recomp(i); }             // the lava went into making the stone below it
          else { let q = capFrac(FREACT_QUENCH_F); const pb = pj * T;     // ...or the other liquid flashes off above the crust
            for (let rk = T - 1; rk >= 1 && q > 0; rk--) { const a = amt[pb + rk]; if (a <= 0) continue; const mv = a < q ? a : q; amt[pb + rk] = a - mv; q -= mv; }
            recomp(pj); }
          liqChanged.add(pj); if (tot[pj] > 0) act.add(pj); else act.delete(pj);
          wakeN(pj);
        }
        setSolid(sj, 2); addFx(sj, 1);
        continue;
      }
      // ── (D) OIL IGNITES on contact with lava. The lava is not consumed; the fire then spreads through the slick on
      // its own (see the fire phase), so a pool lights at the point of contact and runs back through itself.
      let oj = amt[b + 5] > 0 ? i : -1;
      if (oj < 0) for (const j of NB) { if (j >= 0 && j < N && amt[j * T + 5] > 0) { oj = j; break; } }
      if (oj >= 0) fineFireSet(room).add(oj);
  }
  // ── FIRE: every burning cell consumes its oil and lights any neighbour holding oil. Driven by its own set rather
  // than the anchors, so a slick keeps burning after everything has settled and stopped moving.
  const fire = roomFineFire[room];
  if (fire && fire.size) for (const i of Array.from(fire)) {
    const b = i * T;
    if (i < 0 || i >= N || amt[b + 5] <= 0) { fire.delete(i); continue; }   // burnt out (or the oil moved on)
    const oburn = capFrac(FREACT_OIL_BURN_F); amt[b + 5] = amt[b + 5] > oburn ? amt[b + 5] - oburn : 0;
    recomp(i); liqChanged.add(i); if (tot[i] > 0) act.add(i); else act.delete(i); wakeN(i);
    addFx(i, 7);                                                            // flame, every pass it is alight — not a one-shot
    if (amt[b + 5] <= 0) fire.delete(i);
    const c = i % COLS;
    for (const j of [i + COLS, i - COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1])
      if (j >= 0 && j < N && amt[j * T + 5] > 0) fire.add(j);              // the flame front
  }
  if (fire && !fire.size) delete roomFineFire[room];
  // ── PHASE 2: ACID. Transferred from the coarse liquidTickRoom block, same model: SOAK adjacent water into this cell's
  // dilution (consuming it) and CONVERT acid→water once saturated; with no water to neutralise against, DISSOLVE an
  // adjacent breakable solid instead (never bedrock, never glass). Both are GRADUAL, so — like the oil burn — they do
  // not resolve their own contact in one pass and must re-seed or they stall the moment the pool settles.
  for (const i of anchors) {
    const b = i * T, acid = amt[b + 3];
    if (acid <= 0 || amt[b] > 0) continue;                  // (lava contact already turned this cell to stone in phase 1)
    const c = i % COLS, NB = [i + COLS, i - COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];
    const dil = ensureDilute(room);
    let waterSrc = amt[b + 4] > 0 ? i : -1;
    if (waterSrc < 0) for (const j of NB) { if (j >= 0 && j < N && amt[j * T + 4] > 0) { waterSrc = j; break; } }
    if (waterSrc >= 0 || dil[i] >= ACID_K) {
      if (waterSrc >= 0 && (tick % ACID_SOAK_TICKS) === 0 && dil[i] < acid * ACID_K) {   // SOAK 1 water → dilution (consumed)
        amt[waterSrc * T + 4] -= 1; dil[i] += 1;
        recomp(waterSrc); liqChanged.add(waterSrc); if (tot[waterSrc] > 0) act.add(waterSrc); else act.delete(waterSrc); wakeN(waterSrc);
      }
      if ((tick % ACID_CONVERT_TICKS) === 0 && dil[i] >= ACID_K && amt[b + 3] >= 1) {    // CONVERT 1 saturated acid → water
        amt[b + 3] -= 1; amt[b + 4] += 1; dil[i] -= ACID_K; recomp(i); liqChanged.add(i); act.add(i); wakeN(i);
        if (amt[b + 3] <= 0) dil[i] = 0;
      }
      const rs = fineReactSet(room); rs.add(i); if (waterSrc >= 0) rs.add(waterSrc);
    } else {                                                // nothing to neutralise with → eat an adjacent solid
      let solidJ = -1;
      for (const j of NB) { if (j < 0 || j >= N) continue; if ((j / COLS | 0) >= FLOOR_ROW) continue;
        const g = grid[j]; if (g !== 0 && !isFluidId(g) && hp[j] > 0 && g !== 16) { solidJ = j; break; } }   // never bedrock, never glass (acid-immune)
      if (solidJ >= 0) {
        fineReactSet(room).add(i);                          // gradual: keep the contact alive between bites
        if ((tick % ACID_BITE_TICKS) === 0) {
          addFx(solidJ, 8);                                   // fizz at the bite, every bite — not just the one that breaks through
          if (hp[solidJ] > 1) hp[solidJ] -= 1;
          else { grid[solidJ] = 0; hp[solidJ] = 0; terrCells.push(solidJ, 0); wakeN(solidJ); seedFineReactAround(room, solidJ); }
          const abite = capFrac(FREACT_ACID_COST_F); amt[b + 3] = acid > abite ? acid - abite : 0;
          recomp(i); liqChanged.add(i); if (tot[i] > 0) act.add(i); else act.delete(i); wakeN(i);
        }
      }
    }
  }
  // ── PHASE 3: WATER. Snow contact freezes it to ICE — only water touching SNOW, and ice is not snow, so it cannot
  // chain: exactly a one-cell rime shell. Water still touching lava after phase 1 is left alone, lava wins. Water also
  // SEEDS the saturation model here (the coarse sim did this inline in its water branch, which fine mode never runs).
  for (const i of anchors) {
    const b = i * T;
    if (amt[b] > 0 || amt[b + 4] <= 0) continue;
    const c = i % COLS, NB = [i + COLS, i - COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];
    let snowJ = -1, ss = null;
    for (const j of NB) {
      if (j < 0 || j >= N) continue;
      const g = grid[j];
      if (g === 8 && snowJ < 0) snowJ = j;
      if (g === 1 || g === 3 || g === 5) { if (!ss) ss = soilSet(room); ss.add(j); }   // earth/sand/mud beside water → absorb
    }
    if (snowJ < 0) continue;
    let nearLava = false; for (const j of NB) { if (j >= 0 && j < N && amt[j * T] > 0) { nearLava = true; break; } }
    if (!nearLava) {
      convertSolid(snowJ, 4, 2);                                            // the snow itself becomes the ice, so nothing survives to slide on
      let q = capFrac(FREACT_FREEZE_COST_F); for (let rk = T - 1; rk >= 1 && q > 0; rk--) { const a = amt[b + rk]; if (a <= 0) continue; const mv = a < q ? a : q; amt[b + rk] = a - mv; q -= mv; }
      recomp(i); liqChanged.add(i); if (tot[i] > 0) act.add(i); else act.delete(i); wakeN(i);
    }   // BOTH the snow and the water become one ice cell — the snow must not survive to slide on and freeze a trail
  }
  for (const j of liqChanged) fineSyncGrid(room, j);           // a drained/created stack changes the cell's representative id
  if (liquidQuiet) return;                                    // gen pre-settle: react, but don't broadcast
  if (fx.length) io.to(room).emit('liquid-fx', { cells: fx });
  // ORDER MATTERS now the grid carries fluid ids: a cell the reaction turned SOLID also appears in liqChanged with an
  // empty stack, and applying that after the terrain write would clear the new solid straight back to 0.
  if (liqChanged.size) {                                      // same encoding as the fine tick's own wire
    let arr = [], cells = 0;
    const flush = () => io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr });
    for (const j of liqChanged) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      arr.push(j, liqRepId(amt, j), (sd[j] & 0x03), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
      if (++cells >= 8192) { flush(); arr = []; cells = 0; }
    }
    if (cells) flush();
  }
  if (terrCells.length) io.to(room).emit('terrain-set', { cells: terrCells });
}
// Fine-cell wire helpers. INSIDE the sim block because the sim itself now emits through them: soilTickRoom and
// powderTickRoom both write fine liquid in fine mode, so the harness has to be able to reach these too.
function fineWirePush(room, idxList, cells) {   // append [i, repId, side, mask, amts…] for each fine cell in idxList
  const amt = roomFineAmt[room], sd = roomFineSide[room];
  for (const i of idxList) { const b = i * LIQ_T; let mask = 0; for (let rk = 0; rk < LIQ_T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk); cells.push(i, liqRepId(amt, i), (sd[i] & 3), mask); for (let rk = 0; rk < LIQ_T; rk++) if (mask & (1 << rk)) cells.push(amt[b + rk]); }
}
function emitFineCells(room, idxList) {   // broadcast a set of fine cells immediately (used by placement — the tick only broadcasts what MOVED)
  if (!idxList.length || !roomFineAmt[room]) return;
  const SUB = roomFineSub[room] || 1, cells = []; fineWirePush(room, idxList, cells);
  if (cells.length) io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: TERRAIN_COLS * SUB, cells });
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
  for (const room in roomLiquidSrc) sourceTickRoom(room);   // sources top up first, so their liquid is ordinary pooled liquid to everything below
  // FINE-CELL liquid (experimental) — a parallel sim in its own arrays, ticked only when liquidCfg.fine.
  // Timed SEPARATELY from the coarse sim so the Perf tab can isolate the fine cost at various fineLevelSteps (K).
  const _fine0 = liquidCfg.perfLog ? performance.now() : 0; let _fineActive = 0;
  // FINE REACTIONS — BEFORE the flow, not after. fineLiquidTickRoom consumes roomFineActive (`Array.from(active);
  // active.clear()`) and only re-adds cells that actually MOVED, so a pair that has come to rest in contact is gone from
  // the set by the time the tick returns — running after would miss every static contact, which is most of them. Run
  // first and the set still holds everything that moved last tick, i.e. exactly the cells whose contacts are new.
  // Rooms with no active liquid still get a pass when a terrain edit seeded them.
  const _react = () => {
    const seenRooms = new Set();
    for (const src of [roomFineActive, roomFineReact, roomFineFire])   // a room may be quiet but still have a seeded contact or a burning slick
      for (const room in src) { if (seenRooms.has(room)) continue; seenRooms.add(room); fineReactTickRoom(room, roomFineSub[room] || 1); }
  };
  if (liquidCfg.reactions) _react();
  for (const room in roomFineActive) { if (liquidCfg.perfLog) _fineActive += roomFineActive[room].size; fineLiquidTickRoom(room, roomFineSub[room] || 1); }
  // ...and AGAIN after the flow. The pre-pass catches contacts that were already standing (the set still holds last
  // tick's movers); the post-pass catches contacts this tick's movement JUST created, in the same tick. Without it,
  // lava that lands on a partially-filled cell — which lavaBlk stops it entering — would visibly HOVER over the gap
  // for a tick before crusting. The pass is O(active) and does nothing unless lava is actually touching something.
  if (liquidCfg.reactions) _react();
  if (liquidCfg.perfLog) { const _fdt = performance.now() - _fine0; liqPerf.fineMs += _fdt; if (_fdt > liqPerf.fineMsMax) liqPerf.fineMsMax = _fdt; if (_fineActive > liqPerf.fineActive) liqPerf.fineActive = _fineActive; }
  powderTickCount++; for (const room in roomPowderActive) powderTickRoom(room);   // powder runs in lockstep with liquid → consistent gravity
  if ((liquidTickCount & 3) === 0) for (const room in roomSoilActive) soilTickRoom(room);
  if (liquidCfg.perfLog) {
    const _dt = performance.now() - _t0; liqPerf.simMs += _dt; if (_dt > liqPerf.simMsMax) liqPerf.simMsMax = _dt;
    if (_active > liqPerf.active) liqPerf.active = _active; liqPerf.ticks++;
    if (liqPerf.ticks >= Math.max(1, Math.round(1000 / liquidCfg.tickMs))) {   // ~once per real second
      const _hz = 1000 / liquidCfg.tickMs, _rooms = Object.keys(roomFineActive).length;
      const _stat = { rooms: _rooms, active: liqPerf.active, avgMs: +(liqPerf.simMs / liqPerf.ticks).toFixed(2), maxMs: +liqPerf.simMsMax.toFixed(2), kbs: +(liqPerf.bytes * _hz / liqPerf.ticks / 1024).toFixed(1), budgetMs: liquidCfg.tickMs,
        // FINE-CELL breakout (only meaningful when sub>1): isolated fine sim ms, its own wire KB/s, active-cell peak, mean changed/tick, and the K sub-step count.
        sub: 1, steps: liquidCfg.fineLevelSteps, fineActive: liqPerf.fineActive, fineAvgMs: +(liqPerf.fineMs / liqPerf.ticks).toFixed(2), fineMaxMs: +liqPerf.fineMsMax.toFixed(2), fineKbs: +(liqPerf.fineBytes * _hz / liqPerf.ticks / 1024).toFixed(1), fineChanged: Math.round(liqPerf.fineChanged / liqPerf.ticks) };
      console.log(`[liq-perf] rooms=${_stat.rooms} active(peak)=${_stat.active} sim/tick avg=${_stat.avgMs}ms max=${_stat.maxMs}ms  emit=${_stat.kbs}KB/s` +
        (`  |  FINE sub=${_stat.sub} K=${_stat.steps} active=${_stat.fineActive} fine/tick avg=${_stat.fineAvgMs}ms max=${_stat.fineMaxMs}ms emit=${_stat.fineKbs}KB/s changed/tick=${_stat.fineChanged}`) +
        ` (×clients-in-room = server upload; budget/tick=${_stat.budgetMs}ms)`);
      io.emit('liquid-perf', _stat);                       // mirrored to the Liquid Debug panel so it's visible while testing
      liqPerf = { simMs: 0, simMsMax: 0, active: 0, bytes: 0, ticks: 0, fineMs: 0, fineMsMax: 0, fineActive: 0, fineBytes: 0, fineChanged: 0 };
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
    fineSyncGrid(room, i); fineWakeAround(room, i);
  }
  return filled;
}
function fineClearBlock(room, SUB, cc, cr) {   // clear the SUB×SUB fine block; returns the fine indices that changed
  const amt = roomFineAmt[room], tot = roomFineTotal[room], sd = roomFineSide[room], FCOLS = TERRAIN_COLS * SUB, act = fineSet(room);
  const fx0 = cc * SUB, fy0 = cr * SUB, changed = [];
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fy0 + dy) * FCOLS + (fx0 + dx), b = i * LIQ_T; if (tot[i] > 0 || sd[i]) { for (let k = 0; k < LIQ_T; k++) amt[b + k] = 0; tot[i] = 0; sd[i] = 0; act.delete(i); changed.push(i); fineSyncGrid(room, i); fineWakeAround(room, i); } }
  return changed;
}
function fineToCoarseCell(room, SUB, cc, cr) {   // average a fine block back down to a coarse rank-stack (÷SUB²), clamped to CAP
  const amt = roomFineAmt[room], FCOLS = TERRAIN_COLS * SUB, out = new Array(LIQ_T).fill(0), fx0 = cc * SUB, fy0 = cr * SUB;
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const b = ((fy0 + dy) * FCOLS + (fx0 + dx)) * LIQ_T; for (let k = 0; k < LIQ_T; k++) out[k] += amt[b + k]; }
  const div = SUB * SUB; let ct = 0; for (let k = 0; k < LIQ_T; k++) { out[k] = Math.round(out[k] / div); ct += out[k]; }
  let ex = ct - LIQUID_MAX; for (let k = LIQ_T - 1; k >= 0 && ex > 0; k--) { const d = Math.min(out[k], ex); out[k] -= d; ex -= d; }   // trim overflow from the lightest
  return out;
}
// (upscaleRoomToFine / downscaleRoomToCoarse converted a room between the two liquid grids. With the coarse sim gone
//  there is nothing to convert to or from; seedLiquidActivity now seeds the fine grid directly.)
function buildFineInit(room) {   // join replay: every non-empty fine cell (same mask encoding)
  const tot = roomFineTotal[room]; if (!tot) return null;
  const SUB = roomFineSub[room] || 1, idx = []; for (let i = 0; i < tot.length; i++) if (tot[i] > 0) idx.push(i);
  const cells = []; fineWirePush(room, idx, cells);
  return { sub: SUB, cols: TERRAIN_COLS * SUB, cells };
}
function fineActivateRect(room, grid, c0, r0, c1, r1) {   // placement in fine mode: seed/clear the fine block for each painted coarse cell + broadcast
  const SUB = 1; ensureFineArrays(room, SUB);
  c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(TERRAIN_COLS - 1, c1); r1 = Math.min(TERRAIN_ROWS - 1, r1);
  const changed = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * TERRAIN_COLS + c;
    if (isFluidId(grid[i])) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[grid[i]]] = LIQUID_MAX; for (const x of fineSetBlock(room, SUB, c, r, ca)) changed.push(x); }
    else for (const x of fineClearBlock(room, SUB, c, r)) changed.push(x);
    seedFineReactAround(room, i);   // an edit is the only way a SETTLED pair (lava beside painted snow/water) starts reacting
  }
  // ...and the same for SATURATION. This used to sit in activateLiquidRect's coarse tail, which fine mode returns before
  // reaching — so painting water beside earth never started it absorbing. +1 margin so an edit on either side seeds.
  for (let r = Math.max(0, r0 - 1); r <= Math.min(TERRAIN_ROWS - 1, r1 + 1); r++)
    for (let c = Math.max(0, c0 - 1); c <= Math.min(TERRAIN_COLS - 1, c1 + 1); c++) seedSoilAround(room, grid, r * TERRAIN_COLS + c);
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
      const add = free < toAdd ? free : toAdd; amt[i * LIQ_T + rank] += add; tot[i] += add; led[rank] += add; toAdd -= add; act.add(i); touched.add(i); fineSyncGrid(room, i);
    }
  }
  if (!src.size) delete roomLiquidSrc[room];
  if (touched.size) emitFineCells(room, Array.from(touched));
}
// Wake the fine liquid in a COARSE cell rect (after a terrain edit) so it flows into freed space — add to add, never seed
// or clear (seeding/clearing is done explicitly by placement). Grid is decoupled in fine mode, so this reads only fine state.
function fineWakeRect(room, c0, r0, c1, r1) {
  const tot = roomFineTotal[room]; if (!tot) return;
  const SUB = roomFineSub[room] || 1, FCOLS = TERRAIN_COLS * SUB, FROWS = TERRAIN_ROWS * SUB, act = fineSet(room);
  const fc0 = Math.max(0, c0 * SUB), fc1 = Math.min(FCOLS - 1, (c1 + 1) * SUB - 1), fr0 = Math.max(0, r0 * SUB), fr1 = Math.min(FROWS - 1, (r1 + 1) * SUB - 1);
  for (let r = fr0; r <= fr1; r++) for (let c = fc0; c <= fc1; c++) { const i = r * FCOLS + c; if (tot[i] > 0) act.add(i); }
}
// Rescale every room's liquid (coarse + fine) from the current LIQUID_MAX to `newCap` so a full cell stays full when the
// cell-capacity slider changes. Uint8-safe (clamped ≤255). Recomputes totals. Caller then sets LIQUID_MAX + re-broadcasts.
function rescaleAllLiquid(newCap) {
  const oldCap = LIQUID_MAX; if (newCap === oldCap || oldCap <= 0) return;
  const f = newCap / oldCap;
  const doArr = (amtArr, totArr) => { if (!amtArr || !totArr) return; for (let i = 0; i < totArr.length; i++) { const b = i * LIQ_T; let s = 0; for (let k = 0; k < LIQ_T; k++) { let v = Math.round(amtArr[b + k] * f); if (v > 255) v = 255; amtArr[b + k] = v; s += v; } totArr[i] = s > 255 ? 255 : s; } };
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
  const surf = new Int16Array(TERRAIN_COLS);
  for (let c = 0; c < TERRAIN_COLS; c++) surf[c] = (Math.abs(c - centerCol) <= plateauHalf) ? plateauSurf : heightAt(c);
  const crustMat = (biome, r, s) => biome === 'desert' ? MAT.SAND : biome === 'snow' ? (r === s ? MAT.SNOW : MAT.EARTH) : biome === 'swamp' ? MAT.MUD : biome === 'volcanic' ? MAT.STONE : MAT.EARTH;
  // ---- 1. Solid fill: biome crust over a depth-layered underground (dirt → stone+veins → deep) ----
  for (let c = 0; c < TERRAIN_COLS; c++) {
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
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const top = surf[c] + CRUST + 1;
    for (let r = top; r <= bottomRow; r++) {
      const i = r * TERRAIN_COLS + c; if (!grid[i]) continue;
      const depth = (r - top) / Math.max(1, bottomRow - top);
      const worm = Math.abs(Math.sin((c * 0.06 + r * 0.033) / G + cp0) + Math.sin((c * 0.025 - r * 0.052) / G + cp1) + Math.sin((c + r) * 0.041 / G + cp2));
      const chamber = Math.sin((c * 0.018 + r * 0.022) / G + cp3) + Math.sin((c * 0.034 - r * 0.013) / G + cp4);   // rare small pockets
      if (worm < 0.24 + depth * 0.12 || chamber > 1.86 - depth * 0.26) { grid[i] = 0; hp[i] = 0; }     // narrow tunnels + occasional pocket
    }
  }
  // ---- 3a. Surface lakes: flood valley air below sea level with Water ----
  for (let c = 0; c < TERRAIN_COLS; c++) if (inBand(c) && surf[c] > seaRow) for (let r = seaRow; r < surf[c]; r++) set(c, r, MAT.WATER);
  // ---- 3b. Cave pools: shallow fluid resting on cave floors. ONE liquid per underground region (no random
  // mixing) so each area reads coherently — molten→Lava, sandstone→Quicksand, fungal→Brine, everywhere
  // else→Water. Patchy along the width via a wet field; molten always seeps at the very bottom. ----
  const wp = rng() * Math.PI * 2, wp2 = rng() * Math.PI * 2, POOL_DEPTH = Math.round(4 * G);
  const regionFluid = { molten: MAT.LAVA, sandstone: MAT.QUICKSAND, fungal: MAT.BRINE, frozen: MAT.WATER, crystal: MAT.WATER, caverns: MAT.WATER };
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const uB = ugBiome(c);
    const fluid = regionFluid[uB] || MAT.WATER;
    const wet = Math.sin(c * 0.02 / G + wp) + 0.5 * Math.sin(c * 0.061 / G + wp2);
    const wetOK = uB === 'molten' ? true : wet > 0.25;                 // molten always seeps; others patchy
    const tableRow = uB === 'molten' ? bottomRow - Math.round(10 * G) : surf[c] + CRUST + Math.round(14 * G);   // no cave pools too near the surface
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
  for (let c = Math.max(8, genC0); c < Math.min(TERRAIN_COLS - 8, genC1); c += Math.round(6 * G)) {   // surface rock mounds (terrain); step ×G keeps physical spacing
    if (rng() > 0.10 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const hgt = (1 + (rng() * 2 | 0)) * G;
    for (let k = 0; k < hgt; k++) { set(c, surf[c] - 1 - k, MAT.STONE); if (rng() > 0.5) set(c + 1, surf[c + 1] - 1 - k, MAT.STONE); }
  }
  for (let c = Math.max(5, genC0); c < Math.min(TERRAIN_COLS - 5, genC1); c += Math.round(4 * G)) {   // surface trees (narrow solid stamps); step ×G keeps physical spacing
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
    if (!outsideSpawn(wx) || y < TERRAIN_CELL * 3 * G) continue;   // ×G: keep the same physical top-margin (72px)
    addObj({ type: 'platform', x: wx, y, w: 110 + (rng() * 120 | 0), h: 16, angle: 0, spin: 0, boost: 0, updraft: 0, fanLen: 1, fanMode: 'push', fanPeriod: 2, hp: null });
  }
  // Underground scatter: props + the occasional bouncy fungus/crystal platform, resting on cave floors.
  const cryFor = { frozen: '❄️', crystal: '💎', fungal: '🍄', sandstone: '🪨', caverns: '💧', molten: '' };
  for (let c = Math.max(4, genC0); c < Math.min(TERRAIN_COLS - 4, genC1); c += Math.round(3 * G)) {   // underground scatter; step ×G keeps physical spacing
    if (wn >= OBJ_CAP) break;
    const uB = ugBiome(c);
    for (let r = surf[c] + CRUST + Math.round(6 * G); r <= bottomRow - 1; r++) {
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
    const fact = roomFineActive[avatarRoom];
    const seeded = roomFineReact[avatarRoom], burning = roomFineFire[avatarRoom];
    if (!(fact && fact.size) && !(seeded && seeded.size) && !(burning && burning.size)) break;
    liquidTickCount++;
    const SUB = roomFineSub[avatarRoom] || 1;
    if (liquidCfg.reactions) fineReactTickRoom(avatarRoom, SUB);
    fineLiquidTickRoom(avatarRoom, SUB);
    if (liquidCfg.reactions) fineReactTickRoom(avatarRoom, SUB);
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
  if (sc === TERRAIN_COLS && sr === TERRAIN_ROWS) {
    for (let idx = 0; idx < grid.length; idx++) { const v = src[idx]; if (v) { grid[idx] = v; hp[idx] = srcHp[idx] || matStrengthSrv(mats, v); } }
  } else {
    for (let r = 0; r < TERRAIN_ROWS; r++) { const rs = Math.min(sr - 1, (r * sr / TERRAIN_ROWS) | 0);
      for (let c = 0; c < TERRAIN_COLS; c++) { const cs = Math.min(sc - 1, (c * sc / TERRAIN_COLS) | 0); const si = rs * sc + cs, v = src[si]; if (v) { const di = r * TERRAIN_COLS + c; grid[di] = v; hp[di] = srcHp[si] || matStrengthSrv(mats, v); } } }
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
    if (!room || !roomTerrain[room]) return;
    const fi = buildFineInit(room); if (fi) socket.emit('liquid-fine-init', { ...fi, verify: true });
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
  // ⭐ MIRROR CHECK (diagnostic). The client only ever receives CHANGED fine cells, so ANY server-side write that does
  // not make it into a broadcast leaves the client's mirror wrong FOREVER — the cell is never mentioned again. That
  // shows up as liquid frozen in place, and (because the rise/sink bubble FX key off a density inversion between
  // MIRROR cells) as bubbles that never stop. This hands back the server's authoritative stack for a rectangle of
  // cells so the client can diff its mirror against it and say exactly which cells disagree.
  // Same flat encoding as the fine wire — [i, repId, side, mask] + one amt per set rank — but for EVERY cell in the
  // rect, empty ones included (mask 0), because a PHANTOM (client has liquid where the server has none) is the case
  // we are hunting and it is invisible if empties are omitted.
  socket.on('liquid-mirror-check', (rect) => {
    const room = currentAvatarRoom;
    if (!room || !rect || typeof rect !== 'object') return;
    const amt = roomFineAmt[room], tot = roomFineTotal[room], sd = roomFineSide[room], grid = roomTerrain[room];
    if (!amt || !tot || !grid) { socket.emit('liquid-mirror-state', { err: 'no fine state for this room' }); return; }
    const SUB = roomFineSub[room] || 1 || 1, FCOLS = TERRAIN_COLS * SUB, FROWS = TERRAIN_ROWS * SUB;
    const cl = (v, hi) => Math.max(0, Math.min(hi, v | 0));
    const c0 = cl(rect.c0, FCOLS - 1), c1 = cl(rect.c1, FCOLS - 1), r0 = cl(rect.r0, FROWS - 1), r1 = cl(rect.r1, FROWS - 1);
    if (c1 < c0 || r1 < r0) return;
    const W = c1 - c0 + 1, H = r1 - r0 + 1;
    if (W * H > 90000) { socket.emit('liquid-mirror-state', { err: 'rect too large (' + W + '×' + H + ') — zoom in' }); return; }
    const cells = [], T = LIQ_T;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * FCOLS + c, b = i * T;
      let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      cells.push(i, tot[i] > 0 ? liqRepId(amt, i) : grid[i], sd[i] & 0x03, mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) cells.push(amt[b + rk]);
    }
    const act = roomFineActive[room];
    // ⭐⭐ WHY ISN'T THIS PAIR SORTING? The mirror came back clean, so a standing inversion is really in the server's
    // state — and the sub-step loop runs 9 sort passes a tick, each guaranteed to move at least 1 unit once the swap
    // fires. So the swap is not firing, and the sim knows exactly which of its gates is stopping it. Rather than guess
    // at the geometry (10 hand-built + 1320 randomised scenes never produced one), report every gate's value for each
    // standing pair. Mirrors the conditions on step (2) in fineLiquidTickRoom verbatim — keep the two in step.
    const FROW_FLOOR = Math.floor(FLOOR_TOP / TERRAIN_CELL) * SUB;
    const isSolidF = (k) => { if (k < 0 || k >= FCOLS * FROWS) return true; const fr = (k / FCOLS) | 0, fc = k - fr * FCOLS;
      const v = grid[((fr / SUB) | 0) * TERRAIN_COLS + ((fc / SUB) | 0)]; return v !== 0 && !isFluidId(v); };
    const floorRk = (j) => { const b = j * T; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) return rk; return -1; };
    const ceilRk = (j) => { const b = j * T; for (let rk = T - 1; rk >= 0; rk--) if (amt[b + rk] > 0) return rk; return -1; };
    const stk = (j) => { const o = []; for (let rk = 0; rk < T; rk++) if (amt[j * T + rk] > 0) o.push(rk + ':' + amt[j * T + rk]); return '{' + o.join(' ') + '}'; };
    const lavaB = (A, B) => { if (!liquidCfg.reactions) return false; const la = amt[A * T] > 0, lb = amt[B * T] > 0;
      if (!la && !lb) return false; return (la && tot[B] - amt[B * T] > 0) || (lb && tot[A] - amt[A * T] > 0); };
    const stuck = []; let invTotal = 0;
    for (let r = r0; r < r1; r++) for (let c = c0; c <= c1; c++) {
      const a = r * FCOLS + c, b = a + FCOLS;
      if (tot[a] <= 0 || tot[b] <= 0) continue;
      const f = floorRk(a); if (f < 0 || f >= ceilRk(b)) continue;
      invTotal++;
      if (stuck.length >= 8) continue;
      stuck.push({
        c, r, up: stk(a), dn: stk(b),
        hi: f, lo: ceilRk(b),
        upActive: !!(act && act.has(a)), dnActive: !!(act && act.has(b)),
        upSolid: isSolidF(a), dnSolid: isSolidF(b),          // a solid grid id over a cell that still holds liquid = the sim skips it AND wake() refuses to re-add it → permanent
        gUp: grid[a], gDn: grid[b],
        canDown: r + 1 < FROW_FLOOR,                          // step (2) requires it; false near the bedrock row
        sdUp: sd[a], sdDn: sd[b],                             // streamNoSort / streamNoSortNbr gate on these
        lavaBlk: lavaB(a, b),
        k: Math.min(amt[a * T + f], amt[b * T + ceilRk(b)], liquidCfg.sortRate),
      });
    }
    socket.emit('liquid-mirror-state', { sub: SUB, cols: FCOLS, c0, r0, c1, r1, cells, cap: LIQUID_MAX,
      active: act ? act.size : 0, tick: liquidTickCount, invTotal, stuck,
      cfg: { densitySort: liquidCfg.densitySort, streamTag: liquidCfg.streamTag, streamNoSort: liquidCfg.streamNoSort,
             streamNoSortNbr: liquidCfg.streamNoSortNbr, sortRate: liquidCfg.sortRate, K: liquidCfg.fineLevelSteps,
             sortSteps: liquidCfg.fineSortSteps, reactions: liquidCfg.reactions, minUnit: liquidCfg.fineMinUnit } });
  });
  socket.on('liquid-cfg', (patch) => {
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['densitySort', 'sortBeforeLevel', 'ledgeSpill', 'lateralLevel', 'perLiquidLevel', 'viscosity', 'reactions', 'streamTag', 'streamMix', 'streamNoSort', 'streamNoSortNbr', 'symLevel', 'levelMix', 'perfLog', 'fluxLevel', 'paused', 'fineLedge', 'fineQuiesce', 'fineAdaptiveK', 'fineConstFall', 'fineSortDiagGate', 'finePerLiquidSortGate', 'fineSortOnePerPass']) if (k in patch) liquidCfg[k] = !!patch[k];
    if ('levelGate' in patch) liquidCfg.levelGate = Math.max(0, Math.min(3, patch.levelGate | 0));
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
    // CELL CAPACITY (vertical slices). Rescale existing liquid, then re-broadcast so client mirrors match the new scale.
    if ('cellCap' in patch) { const nv = Math.max(1, Math.min(255, patch.cellCap | 0)); if (nv !== LIQUID_MAX) { rescaleAllLiquid(nv); LIQUID_MAX = nv; liquidCfg.cellCap = nv;
      for (const room in roomFineTotal) { const fi = buildFineInit(room); if (fi) io.to(room).emit('liquid-fine-init', fi); }
    } }
    // (The fine/coarse gate toggle lived here. There is no coarse sim to switch to any more, so `fine` and `sub` are
    //  no longer accepted as patches — the fine grid at ratio 1 is the only liquid there is.)
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
    if (tg) { const fi = buildFineInit(avRoom); if (fi && fi.cells.length) socket.emit('liquid-fine-init', fi); }
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); delete roomPowderActive[currentAvatarRoom]; clearFineRoom(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); }
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); delete roomPowderActive[currentAvatarRoom]; clearFineRoom(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); }
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
    const rr = Math.max(TERRAIN_CELL / 2, Math.min(160, r));   // floor = one fine tile's half-extent so the client's smallest (1-cell) brush isn't inflated server-side
    const m = (op === 'paint') ? (Math.min(TERRAIN_MAT_HI, Math.max(1, mat | 0)) || 1) : 0;  // material id 1..255 (carve = 0)
    const sq = shape === 'square';
    const hd = op === 'carve' && !!hard;                 // editor Carve tool: hard delete (any block); gameplay slam stays soft
    if (op === 'paint' && aabbHitsClear(spawnClearRect(currentAvatarRoom), cx - rr, cy - rr, cx + rr, cy + rr)) return; // no building on the spawn (world mode)
    const grid = ensureTerrain(currentAvatarRoom), hp = ensureTerrainHp(currentAvatarRoom), mats = roomMats[currentAvatarRoom] || {};
    // The sender already applied this op optimistically, so echo to OTHERS only — carve = hp decrement is
    // NOT idempotent, double-applying would desync the sender's per-cell hp from everyone else's.
    if ((sq ? rasterTerrainSquare : rasterTerrainCircle)(grid, hp, mats, cx, cy, rr, m, hd)) {
      // Wake any liquid in/around the edit so it flows into the freed space (dig-out) or spreads (poured).
      {
        // Liquid is DECOUPLED from the grid. A fluid paint → seed the fine block + set the grid back to EMPTY
        // (no fluid-id litter → no phantom FX / "can't place" / re-seed on the next edit). Solid-over-liquid + carve clear
        // the fine block; surrounding fine liquid is only WOKEN, never re-seeded from the grid.
        ensureFineArrays(currentAvatarRoom, 1);
        const bc0 = Math.max(0, Math.floor((cx - rr) / TERRAIN_CELL)), bc1 = Math.min(TERRAIN_COLS - 1, Math.floor((cx + rr) / TERRAIN_CELL));
        const br0 = Math.max(0, Math.floor((cy - rr) / TERRAIN_CELL)), br1 = Math.min(TERRAIN_ROWS - 1, Math.floor((cy + rr) / TERRAIN_CELL));
        const changedFine = [];
        for (let r = br0; r <= br1; r++) for (let c = bc0; c <= bc1; c++) { const i = r * TERRAIN_COLS + c;
          if (op === 'paint' && isFluidId(m) && grid[i] === m) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[m]] = LIQUID_MAX; for (const x of fineSetBlock(currentAvatarRoom, 1, c, r, ca)) changedFine.push(x); grid[i] = 0; hp[i] = 0; }
          else if (op === 'carve' || (op === 'paint' && isSolidCell(grid[i]))) for (const x of fineClearBlock(currentAvatarRoom, 1, c, r)) changedFine.push(x);
        }
        fineWakeRect(currentAvatarRoom, bc0 - 1, br0 - 1, bc1 + 1, br1 + 1);
        emitFineCells(currentAvatarRoom, changedFine);
      }
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
    {
      // Route liquid placement into the FINE grid. The old inline coarse seed (below) would drop the liquid
      // into the coarse sim, which the fine renderer skips → the "placed liquid is invisible / trapped mid-air" bug.
      ensureFineArrays(currentAvatarRoom, 1); const changedFine = [];
      for (let k = 0; k + 1 < cells.length; k += 2) {
        const i = cells[k] | 0; if (i < 0 || i >= grid.length) continue;
        const cc = i % TERRAIN_COLS, cr = (i / TERRAIN_COLS) | 0;
        if (isFluidId(grid[i])) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[grid[i]]] = LIQUID_MAX; for (const x of fineSetBlock(currentAvatarRoom, 1, cc, cr, ca)) changedFine.push(x); hp[i] = 0; }   // the painted fluid id STAYS in the grid (re-coupled)
        else for (const x of fineClearBlock(currentAvatarRoom, 1, cc, cr)) changedFine.push(x);   // a solid/empty coarse cell clears its fine block
        if (isPowderId(grid[i])) powderSet(currentAvatarRoom).add(i); const up = i - TERRAIN_COLS; if (up >= 0 && isPowderId(grid[up])) powderSet(currentAvatarRoom).add(up);
        seedFineReactAround(currentAvatarRoom, i);   // explicit cell write (undo/paste/scene) can put a solid next to settled liquid
      }
      emitFineCells(currentAvatarRoom, changedFine);
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
