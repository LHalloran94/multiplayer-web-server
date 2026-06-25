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

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
  const { name, description, public: isPublic, scope, url, env_spec, levelLock, features } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const id = generateRoomCode();
    const trimmedName = name.trim().slice(0, 40);
    const trimmedDesc = (description || '').trim().slice(0, 100) || null;
    const pub = isPublic ? 1 : 0;
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
      if (Object.keys(feats).length) { permsObj = permsObj || {}; permsObj.features = feats; }
    }
    const perms = permsObj ? JSON.stringify(permsObj) : null;
    db.prepare('INSERT INTO rooms (id, name, owner_id, public, scope, url, description, kind, env_spec, perms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, trimmedName, user.sub, pub, roomScope, roomUrl, trimmedDesc, kind, spec ? JSON.stringify(spec) : null, perms);
    db.prepare('INSERT INTO room_members (room_id, discord_id) VALUES (?, ?)').run(id, user.sub);
    res.json({ id, name: trimmedName, owner_id: user.sub, member_count: 1, public: pub, scope: roomScope, url: roomUrl, description: trimmedDesc, kind, env_spec: spec });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms/public', (req, res) => {
  const hostname = (req.query.hostname || '').trim().toLowerCase();
  const url = (req.query.url || '').trim();
  try {
    // Return every public room relevant to THIS page in one shot — bound to this exact URL, OR to this
    // site (scope=hostname, not URL-bound), OR global (no binding). The client buckets these into the
    // launcher's "This page" / "This site" / "Public" sub-tabs.
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.scope, r.url, r.description, r.kind, r.env_spec,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count
      FROM rooms r
      WHERE r.public = 1 AND (r.kind IS NULL OR r.kind != 'published') AND (
        r.url = ? OR
        (r.url IS NULL AND r.scope = ?) OR
        (r.url IS NULL AND r.scope IS NULL)
      )
      ORDER BY r.created_at DESC LIMIT 80
    `).all(url || '\x00', hostname || '');
    res.json(rows.map(r => ({ ...r, env_spec: parseEnvSpec(r.env_spec) })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.description, r.kind, r.env_spec,
             (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
      WHERE r.kind IS NULL OR r.kind != 'published'
      ORDER BY r.created_at ASC
    `).all(user.sub);
    res.json(rows.map(r => ({ ...r, env_spec: parseEnvSpec(r.env_spec) })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/join', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const room = db.prepare('SELECT id, name, owner_id, public, scope, description, kind, env_spec FROM rooms WHERE id = ?').get(code.toUpperCase().trim());
    if (!room) return res.status(404).json({ error: 'Room not found' });
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
  try {
    const rows = db.prepare(`SELECT w.id, w.owner_id, w.room_id, w.name, w.author, w.description, w.thumb, w.level_count, w.allow_remix, w.durability, w.play_count, w.updated_at, r.env_spec
      FROM published_worlds w LEFT JOIN rooms r ON r.id = w.room_id ORDER BY w.updated_at DESC LIMIT 120`).all();
    res.json(rows.map(r => ({
      ...r, allow_remix: !!r.allow_remix, env_spec: parseEnvSpec(r.env_spec),
      players_now: (io.sockets.adapter.rooms.get('pg:' + r.room_id) || { size: 0 }).size,
    })));
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
      SELECT rm.from_discord_id, u.username, rm.text, rm.sent_at
      FROM room_messages rm
      LEFT JOIN users u ON u.discord_id = rm.from_discord_id
      WHERE rm.room_id = ?
      ORDER BY rm.sent_at ASC LIMIT 100
    `).all(id);
    res.json(rows.map(r => ({ fromDiscordId: r.from_discord_id, username: r.username || 'Unknown', text: r.text, ts: r.sent_at })));
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
const BUILTIN_STRENGTH = { 2: 3, 4: 2, 5: 2 };         // stone tough, ice/mud middling (matches client TERRAIN_MATS); others 1
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
const TERRAIN_MAT_MAX = 15;                           // built-in material ids 1..15 (earth/stone/sand/ice/mud/bouncy/belt→/snow/water/quicksand/lava/acid/belt←/brine/oil); 0 = empty
const TERRAIN_MAT_HI = 255;                          // grid is Uint8 → custom material ids live in 16..255
// ---- Custom material registry (Stage 6 feature A): per-room map of custom mat id → opaque appearance/property def.
// The server stores + dedups + assigns ids; it does NOT interpret the def physically (the client clones a base mat).
const CUSTOM_MAT_MIN = 16, CUSTOM_MAT_CAP = 200;     // up to 200 custom mats per room
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
function mulberry32(a) {                              // tiny deterministic PRNG (same family the client could mirror)
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Seeded procedural WORLD generation written straight into the existing terrain grid + object map
// (the terrain/object pipelines already render + collide all of it — no new client code). Phases:
// heightmap hills → biomes (grass/desert/snow soil) → caves carved through the stone → valley lakes
// (Water; Lava in occasional deep bands) → surface scatter (rock mounds in terrain; trees + floating
// platforms as 'world'-owned objects, protected from the FIFO cap). Deterministic from the seed.
const MAT = { EARTH: 1, STONE: 2, SAND: 3, SNOW: 8, WATER: 9, LAVA: 11 };
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
  const bottomRow = Math.ceil(FLOOR_TOP / TERRAIN_CELL) - 1;            // last terrain row resting on the floor
  const baseRow = bottomRow - 16;                                       // mean surface row
  // Heightmap: 3 octaves, random phase + amplitude (tuned for the wide world).
  const p0 = rng() * Math.PI * 2, p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const a0 = 6 + rng() * 5, a1 = 2.5 + rng() * 2.5, a2 = 1 + rng() * 1.5;
  const heightAt = (c) => { const h = Math.sin(c * 0.018 + p0) * a0 + Math.sin(c * 0.052 + p1) * a1 + Math.sin(c * 0.13 + p2) * a2; const s = Math.round(baseRow - h); return s < 2 ? 2 : (s > bottomRow ? bottomRow : s); };
  // Biomes: a slow field over the width → grass / desert / snow (drives the soil material).
  const bp0 = rng() * Math.PI * 2, bp1 = rng() * Math.PI * 2;
  const biomeAt = (c) => { const v = Math.sin(c * 0.013 + bp0) + 0.6 * Math.sin(c * 0.031 + bp1); return v > 0.85 ? 'snow' : (v < -0.85 ? 'desert' : 'grass'); };
  const seaRow = baseRow + 7;                                           // valleys deeper than this flood with Water
  // Flat spawn plateau, clamped above the water line so spawn is dry + level.
  const centerCol = Math.floor((MWSim.C.WORLD_W / 2) / TERRAIN_CELL);
  const plateauHalf = Math.ceil(SPAWN_CLEAR_HALF_W / TERRAIN_CELL) + 2;
  let plateauSurf = heightAt(centerCol); if (plateauSurf > seaRow - 3) plateauSurf = seaRow - 3; if (plateauSurf < 2) plateauSurf = 2;
  const surf = new Int16Array(TERRAIN_COLS);
  for (let c = 0; c < TERRAIN_COLS; c++) surf[c] = (Math.abs(c - centerCol) <= plateauHalf) ? plateauSurf : heightAt(c);
  // Soil crust (biome material, top ~5 rows) over Stone.
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const biome = (Math.abs(c - centerCol) <= plateauHalf) ? 'grass' : biomeAt(c);
    const s = surf[c];
    for (let r = s; r <= bottomRow; r++) {
      let v = MAT.STONE;
      if (r < s + 5) v = (biome === 'desert') ? MAT.SAND : (biome === 'snow' ? (r === s ? MAT.SNOW : MAT.EARTH) : MAT.EARTH);
      set(c, r, v);
    }
  }
  // Caves: carve winding tunnels through the stone (keep the soil crust + the surface intact); wider deeper.
  const cp0 = rng() * Math.PI * 2, cp1 = rng() * Math.PI * 2, cp2 = rng() * Math.PI * 2;
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const top = surf[c] + 5;
    for (let r = top; r <= bottomRow; r++) {
      const i = r * TERRAIN_COLS + c;
      if (grid[i] !== MAT.STONE) continue;
      const worm = Math.abs(Math.sin(c * 0.05 + r * 0.028 + cp0) + Math.sin(c * 0.021 - r * 0.045 + cp1) + Math.sin((c + r) * 0.035 + cp2));
      const depth = (r - top) / Math.max(1, bottomRow - top);
      if (worm < 0.42 + depth * 0.22) { grid[i] = 0; hp[i] = 0; }
    }
  }
  // Lakes: flood valley air below sea level with Water; occasional Lava bands at the cave floor.
  for (let c = 0; c < TERRAIN_COLS; c++) if (inBand(c) && surf[c] > seaRow) for (let r = seaRow; r < surf[c]; r++) set(c, r, MAT.WATER);
  const lp = rng() * Math.PI * 2;
  for (let c = 0; c < TERRAIN_COLS; c++) if (inBand(c) && Math.sin(c * 0.008 + lp) > 0.6) for (let r = bottomRow; r > bottomRow - 2; r--) { if (grid[r * TERRAIN_COLS + c] === 0) set(c, r, MAT.LAVA); }
  // Surface scatter: rock mounds (terrain), then trees + floating platforms ('world'-owned objects).
  if (!roomObjects[avatarRoom]) roomObjects[avatarRoom] = new Map();
  const objs = roomObjects[avatarRoom];
  const clearX0 = MWSim.C.WORLD_W / 2 - SPAWN_CLEAR_HALF_W - 64, clearX1 = MWSim.C.WORLD_W / 2 + SPAWN_CLEAR_HALF_W + 64;
  const dryLand = (c) => surf[c] <= seaRow && !!grid[surf[c] * TERRAIN_COLS + c];   // solid, non-flooded surface
  const outsideSpawn = (wx) => wx < clearX0 || wx > clearX1;
  const treeFor = { grass: '🌳', desert: '🌴', snow: '🌲' };
  let wn = 0;
  for (let c = Math.max(8, genC0); c < Math.min(TERRAIN_COLS - 8, genC1); c += 6) {   // rock mounds
    if (rng() > 0.10 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const hgt = 1 + (rng() * 2 | 0);
    for (let k = 0; k < hgt; k++) { set(c, surf[c] - 1 - k, MAT.STONE); if (rng() > 0.5) set(c + 1, surf[c + 1] - 1 - k, MAT.STONE); }
  }
  for (let c = Math.max(5, genC0); c < Math.min(TERRAIN_COLS - 5, genC1); c += 4) {   // trees (narrow solid stamps)
    if (rng() > 0.16 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const h = 58 + (rng() * 28 | 0), w = Math.round(h * 0.5);
    objs.set('world-' + wn, { id: 'world-' + wn, type: 'stamp', ownerId: 'world', owner: 'world',
      x: (c + 0.5) * TERRAIN_CELL, y: surf[c] * TERRAIN_CELL - h / 2, content: treeFor[biomeAt(c)] || '🌳', w, h, shape: 'rect', angle: 0, stretch: false, hp: 3 });
    wn++;
  }
  const platLo = Math.max(10, genC0), platHi = Math.min(TERRAIN_COLS - 10, genC1);   // platform column range (band-confined)
  const plats = platHi > platLo ? 7 + (rng() * 5 | 0) : 0;                            // floating platforms (indestructible) for traversal
  for (let k = 0; k < plats; k++) {
    const c = platLo + (rng() * (platHi - platLo) | 0), wx = (c + 0.5) * TERRAIN_CELL;
    const y = surf[c] * TERRAIN_CELL - (90 + rng() * 170);
    if (!outsideSpawn(wx) || y < TERRAIN_CELL * 3) continue;
    objs.set('world-' + wn, { id: 'world-' + wn, type: 'platform', ownerId: 'world', owner: 'world',
      x: wx, y, w: 110 + (rng() * 120 | 0), h: 16, angle: 0, spin: 0, boost: 0, updraft: 0, fanLen: 1, fanMode: 'push', fanPeriod: 2, hp: null });
    wn++;
  }
}
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
            hp: data.breakable === false ? null : 2 };  // erasable/destructible like other props
    if (type === 'goal' && isFinite(data.target)) obj.target = Math.max(-1, Math.min(63, data.target | 0));  // series destination Level (-1 = next; Phase 5b)
  } else if (type === 'portal') {
    if (!isFinite(data.x) || !isFinite(data.y)) return null;
    obj = { id, type, ownerId, owner: ownerName,
            x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
            pair: (typeof data.pair === 'string' && data.pair.length <= 64) ? data.pair : id,
            entry: data.entry !== false, oneWay: data.oneWay === true,
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

  socket.on('join', ({ url, fullUrl, username, token, visible, tabSession, ctxRoomId }) => {
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
    if (tabSession) {
      for (const oldSid of Object.keys(roomUsers[currentPresenceRoom])) {
        if (oldSid === socket.id || socketToTabSession[oldSid] !== tabSession) continue;
        delete roomUsers[currentPresenceRoom][oldSid];
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
    roomUsers[currentPresenceRoom][socket.id] = { username, verified, avatar, discord_id: discordId };
    if (roomHistory[currentRoom]) socket.emit('history', roomHistory[currentRoom]);
    if (roomMsgReactions[currentRoom]) socket.emit('reactions-init', roomMsgReactions[currentRoom]);
    if (roomAnnotations[currentPageRoom]) socket.emit('annotations-init', roomAnnotations[currentPageRoom]);
    if (roomSprays[currentPageRoom]) socket.emit('sprays-init', roomSprays[currentPageRoom]);
    if (roomMedia[currentRoom]) socket.emit('media-init', roomMedia[currentRoom]);
    if (roomAvatars[currentRoom]) socket.emit('avatars-init', Object.values(roomAvatars[currentRoom]));
    if (roomVoice[currentRoom] && Object.keys(roomVoice[currentRoom]).length) socket.emit('voice-init', roomVoice[currentRoom]);
    broadcastPresence(currentPresenceRoom);
    // Phase 4: seed the active Room's feature policy (null payload for the page-default Room = all open).
    { const fr = resolveAvRoomId(ctxRoomId, currentRoom, socket.id);
      socket.emit('feature-perms', featurePermsPayload(fr !== currentRoom ? fr : null)); }
    socket.to(currentRoom).emit('message', { system: true, text: `${username} joined` });
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
  socket.on('cursor', ({ x, y, scrollPct, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('cursor', { x, y, scrollPct, username, scope, id: socket.id });
  });

  socket.on('pointer-pulse', ({ x, y, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('pointer-pulse', { x, y, username, scope });
  });

  socket.on('reaction', ({ emoji, x, y, username, source, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('reaction', { emoji, x, y, username, source, scope });
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

  socket.on('canvas-stroke-start', ({ id, scope, color, size, eraser, brush, opacity, x, y }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    if (!roomCanvases[key]) roomCanvases[key] = { strokes: new Map(), stamps: [] };
    const data = roomCanvases[key];
    if (data.strokes.size >= MAX_CANVAS_ITEMS) {
      const oldestId = data.strokes.keys().next().value;
      data.strokes.delete(oldestId);
    }
    const bru = brush || 'brush', op = opacity != null ? opacity : 100;
    data.strokes.set(id, { id, username: currentUsername, color, size, eraser: !!eraser, brush: bru, opacity: op, points: [{ x, y }] });
    socket.to(currentRoom).emit('canvas-stroke-start', { id, scope, username: currentUsername, color, size, eraser: !!eraser, brush: bru, opacity: op, x, y });
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
    const spray = { id, content, size, docX, docY, relX, relY, surface, username, scope, timestamp: Date.now() };
    if (!roomSprays[currentPageRoom]) roomSprays[currentPageRoom] = [];
    roomSprays[currentPageRoom].push(spray);
    if (roomSprays[currentPageRoom].length > MAX_SPRAYS) roomSprays[currentPageRoom].shift();
    io.to(currentPageRoom).emit('spray-add', spray);
  });

  socket.on('media-add', ({ id, url, username }) => {
    if (!currentRoom) return;
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); io.to(currentAvatarRoom).emit('terrain-cleared'); }
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); io.to(currentAvatarRoom).emit('terrain-cleared'); }
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
    if ((sq ? rasterTerrainSquare : rasterTerrainCircle)(grid, hp, mats, cx, cy, rr, m, hd))
      socket.to(currentAvatarRoom).emit('terrain-edited', { op, x: cx, y: cy, r: rr, mat: m, shape: sq ? 'square' : undefined, hard: hd });
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
  socket.on('private-room-message', ({ roomId, text }) => {
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
      db.prepare('INSERT INTO room_messages (room_id, from_discord_id, text, sent_at) VALUES (?, ?, ?, ?)').run(roomId, senderDiscordId || null, text.slice(0, 2000), ts);
      socket.to('proom:' + roomId).emit('private-room-message', { roomId, from: username, fromDiscordId: senderDiscordId || null, text, timestamp: ts });
    } catch (e) { console.error('[private-room-message]', e); }
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
  socket.on('ctx-room', ({ roomId } = {}) => {
    if (!currentRoom) return;
    // ---- presence bucket (2c) ----
    const next = resolvePresenceRoom(roomId, currentRoom, socket.id);
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
      roomUsers[next][socket.id] = info || { username: currentUsername, verified: !!socketToDiscordId[socket.id], avatar: null, discord_id: socketToDiscordId[socket.id] || null };
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
      broadcastPresence(currentPresenceRoom);
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
