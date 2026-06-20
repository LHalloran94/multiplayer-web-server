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
  cors: { origin: '*' }
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

// ---- Private room endpoints ----
app.post('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, public: isPublic, scope } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const id = generateRoomCode();
    const trimmedName = name.trim().slice(0, 40);
    const trimmedDesc = (description || '').trim().slice(0, 100) || null;
    const pub = isPublic ? 1 : 0;
    const roomScope = (isPublic && scope) ? scope.trim().slice(0, 253) : null;
    db.prepare('INSERT INTO rooms (id, name, owner_id, public, scope, description) VALUES (?, ?, ?, ?, ?, ?)').run(id, trimmedName, user.sub, pub, roomScope, trimmedDesc);
    db.prepare('INSERT INTO room_members (room_id, discord_id) VALUES (?, ?)').run(id, user.sub);
    res.json({ id, name: trimmedName, owner_id: user.sub, member_count: 1, public: pub, scope: roomScope, description: trimmedDesc });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms/public', (req, res) => {
  const hostname = (req.query.hostname || '').trim().toLowerCase();
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.scope, r.description,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count
      FROM rooms r
      WHERE r.public = 1 AND (r.scope IS NULL OR r.scope = ?)
      ORDER BY r.created_at DESC LIMIT 50
    `).all(hostname || '');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.description,
             (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
      ORDER BY r.created_at ASC
    `).all(user.sub);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/join', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const room = db.prepare('SELECT id, name, owner_id FROM rooms WHERE id = ?').get(code.toUpperCase().trim());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, discord_id) VALUES (?, ?)').run(room.id, user.sub);
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?').get(room.id).c;
    res.json({ ...room, member_count: memberCount });
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
const MAX_OBJECTS_PER_ROOM = 60;   // FIFO cap bounds clutter/memory (destruction is the main limiter)
const OBJ_TYPES = new Set(['platform', 'stamp', 'stroke', 'checkpoint']); // unified primitives (platform absorbs pad/ramp/conveyor/booster/fan/movplat as modifiers); checkpoint = non-solid respawn flag
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
function ensureTerrain(room) { return roomTerrain[room] || (roomTerrain[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function rasterTerrainCircle(grid, wx, wy, r, val) {
  const c0 = Math.max(0, Math.floor((wx - r) / TERRAIN_CELL)), c1 = Math.min(TERRAIN_COLS - 1, Math.floor((wx + r) / TERRAIN_CELL));
  const r0 = Math.max(0, Math.floor((wy - r) / TERRAIN_CELL)), r1 = Math.min(TERRAIN_ROWS - 1, Math.floor((wy + r) / TERRAIN_CELL));
  const r2 = r * r; let changed = false;
  for (let ry = r0; ry <= r1; ry++) for (let cx = c0; cx <= c1; cx++) {
    const ccx = (cx + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
    if ((ccx - wx) * (ccx - wx) + (ccy - wy) * (ccy - wy) <= r2) {
      const i = ry * TERRAIN_COLS + cx; if (grid[i] !== val) { grid[i] = val; changed = true; }
    }
  }
  return changed;
}
const TERRAIN_MAT_MAX = 15;                           // material ids 1..15 (earth/stone/sand/ice/mud/bouncy/belt→/snow/water/quicksand/lava/acid/belt←/brine/oil); 0 = empty
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
  const users = Object.values(roomUsers[room] || {});
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

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;

  socket.on('join', ({ url, fullUrl, username, token, visible, tabSession }) => {
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
    socket.join(currentRoom);
    socket.join('user:' + username);
    userCurrentFullUrl[username] = fullUrl || url;
    if (!roomUsers[currentRoom]) roomUsers[currentRoom] = {};
    roomUsers[currentRoom][socket.id] = { username, verified, avatar, discord_id: discordId };
    if (roomHistory[currentRoom]) socket.emit('history', roomHistory[currentRoom]);
    if (roomMsgReactions[currentRoom]) socket.emit('reactions-init', roomMsgReactions[currentRoom]);
    if (roomAnnotations[currentRoom]) socket.emit('annotations-init', roomAnnotations[currentRoom]);
    if (roomSprays[currentRoom]) socket.emit('sprays-init', roomSprays[currentRoom]);
    if (roomMedia[currentRoom]) socket.emit('media-init', roomMedia[currentRoom]);
    if (roomAvatars[currentRoom]) socket.emit('avatars-init', Object.values(roomAvatars[currentRoom]));
    if (roomVoice[currentRoom] && Object.keys(roomVoice[currentRoom]).length) socket.emit('voice-init', roomVoice[currentRoom]);
    broadcastPresence(currentRoom);
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
          SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.description,
                 (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
          FROM rooms r
          JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
          ORDER BY r.created_at ASC
        `).all(discordId);
        const getMemberIds = db.prepare('SELECT discord_id FROM room_members WHERE room_id = ?');
        socket.emit('private-rooms-init', userRooms.map(r => ({
          ...r,
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

  socket.on('cursor', ({ x, y, scrollPct, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor', { x, y, scrollPct, username, scope, id: socket.id });
  });

  socket.on('pointer-pulse', ({ x, y, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('pointer-pulse', { x, y, username, scope });
  });

  socket.on('reaction', ({ emoji, x, y, username, source, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('reaction', { emoji, x, y, username, source, scope });
  });

  socket.on('soundboard', ({ soundIndex, label, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('soundboard', { soundIndex, label, username, scope });
  });

  socket.on('scroll-position', ({ username, scrollX, scrollY }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('scroll-position', { username, scrollX, scrollY });
  });

  socket.on('highlight', ({ text, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('highlight', { text, username, scope });
  });

  socket.on('annotation-add', ({ id, selector, offsetX, offsetY, text, username, scope }) => {
    if (!currentRoom) return;
    const annotation = { id, selector, offsetX, offsetY, text, username, scope, timestamp: Date.now() };
    if (!roomAnnotations[currentRoom]) roomAnnotations[currentRoom] = [];
    if (!roomAnnotations[currentRoom].find(a => a.id === id)) {
      roomAnnotations[currentRoom].push(annotation);
    }
    io.to(currentRoom).emit('annotation-add', annotation);
  });

  socket.on('annotation-move', ({ id, selector, offsetX, offsetY }) => {
    if (!currentRoom) return;
    if (roomAnnotations[currentRoom]) {
      const ann = roomAnnotations[currentRoom].find(a => a.id === id);
      if (ann) { ann.selector = selector; ann.offsetX = offsetX; ann.offsetY = offsetY; }
    }
    io.to(currentRoom).emit('annotation-move', { id, selector, offsetX, offsetY });
  });

  socket.on('annotation-delete', ({ id }) => {
    if (!currentRoom) return;
    console.log(`[annotation-delete] id: ${id}`);
    if (roomAnnotations[currentRoom]) {
      roomAnnotations[currentRoom] = roomAnnotations[currentRoom].filter(a => a.id !== id);
    }
    io.to(currentRoom).emit('annotation-delete', { id });
  });

  socket.on('draw-start',  (data) => { if (currentRoom) socket.to(currentRoom).emit('draw-start',  data); });
  socket.on('draw-points', (data) => { if (currentRoom) socket.to(currentRoom).emit('draw-points', data); });
  socket.on('draw-end',    (data) => { if (currentRoom) socket.to(currentRoom).emit('draw-end',    data); });

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
    if (!roomSprays[currentRoom]) roomSprays[currentRoom] = [];
    roomSprays[currentRoom].push(spray);
    if (roomSprays[currentRoom].length > MAX_SPRAYS) roomSprays[currentRoom].shift();
    io.to(currentRoom).emit('spray-add', spray);
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
  // carries no game state. Scoped to the URL room (currentRoom).
  socket.on('avt-join', () => {
    if (!currentRoom) return;
    if (!roomAvt[currentRoom]) roomAvt[currentRoom] = new Set();
    const existingPeers = [...roomAvt[currentRoom]];
    roomAvt[currentRoom].add(socket.id);
    socket.emit('avt-joined', { existingPeers });
    // Replay the current world objects to the new joiner (late-joiner sync).
    socket.emit('avatar-objects-init', { objects: roomObjects[currentRoom] ? [...roomObjects[currentRoom].values()] : [] });
    // Replay the destructible terrain grid (RLE) — only if any has been placed in this room.
    const tg = roomTerrain[currentRoom];
    if (tg) socket.emit('terrain-init', { cell: TERRAIN_CELL, cols: TERRAIN_COLS, rows: TERRAIN_ROWS, ...terrainRLE(tg) });
  });
  socket.on('avt-leave', () => {
    if (currentRoom && roomAvt[currentRoom] && roomAvt[currentRoom].delete(socket.id)) {
      socket.to(currentRoom).emit('avt-peer-left', { id: socket.id });
    }
  });
  socket.on('avt-offer',  ({ to, sdp })       => { socket.to(to).emit('avt-offer',  { from: socket.id, sdp }); });
  socket.on('avt-answer', ({ to, sdp })       => { socket.to(to).emit('avt-answer', { from: socket.id, sdp }); });
  socket.on('avt-ice',    ({ to, candidate }) => { socket.to(to).emit('avt-ice',    { from: socket.id, candidate }); });

  // ---- Avatar world objects (Stage 6) — server-authoritative existence over reliable
  // socket.io; physics response is applied locally on each client. Persist till restart.
  socket.on('avatar-object-spawn', (data) => {
    if (!currentRoom || !data || !OBJ_TYPES.has(data.type)) return;
    const type = data.type;
    // Client supplies the id (for optimistic local placement). Require it to be namespaced to
    // this socket (anti-spoof); otherwise mint a fallback. Echoing the same id back means the
    // placer's optimistic object is overwritten in place rather than duplicated.
    let id = data.id;
    if (typeof id !== 'string' || !id.startsWith(socket.id + '-')) id = socket.id + '-s' + (++objSeq);
    if (!roomObjects[currentRoom]) roomObjects[currentRoom] = new Map();
    const map = roomObjects[currentRoom];
    if (map.has(id)) return;                                // ignore duplicate spawn for an existing id
    const WW = MWSim.C.WORLD_W, WH = MWSim.C.WORLD_H;
    let obj;
    if (type === 'stroke') {
      // Freehand solid terrain (Tier B): validate + clamp the world-coord point list.
      if (!Array.isArray(data.pts)) return;
      const pts = [];
      for (const p of data.pts) {
        if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
        pts.push({ x: Math.max(0, Math.min(WW, p.x)), y: Math.max(0, Math.min(WH, p.y)) });
        if (pts.length >= 200) break;                       // per-stroke point cap
      }
      if (pts.length < 2) return;
      let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; }
      obj = { id, type, ownerId: socket.id, owner: currentUsername || socket.id, x: sx / pts.length, y: sy / pts.length, pts,
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
      // Solid, destructible textured box (Tier B): `content` is an emoji or image URL/data-URI.
      // Now carries a shape (rect/ellipse/tri) + rotation angle.
      if (typeof data.content !== 'string' || !data.content || data.content.length > 8192) return;
      if (!isFinite(data.x) || !isFinite(data.y)) return;
      obj = { id, type, ownerId: socket.id, owner: currentUsername || socket.id,
              x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
              content: data.content, w: clampN(data.w, 24, 160, 64), h: clampN(data.h, 24, 160, 64),
              shape: (data.shape === 'ellipse' || data.shape === 'tri') ? data.shape : 'rect',
              angle: clampN(data.angle, -Math.PI, Math.PI, 0),
              stretch: data.stretch === true,               // image stamps: stretch-to-fill vs aspect-fit (default)
              hp: data.breakable === false ? null : 2 };   // indestructible when breakable:false
      if (SURF_TYPES.includes(data.surf)) obj.surf = data.surf;       // contact-property surface modifier
    } else if (type === 'checkpoint') {
      // Respawn flag (Inc 10b): non-solid, no physics. (x, y) is the pole BASE (ground level).
      // Touching it client-side sets that player's local respawn point (broadcast via avatar-checkpoint).
      if (!isFinite(data.x) || !isFinite(data.y)) return;
      obj = { id, type: 'checkpoint', ownerId: socket.id, owner: currentUsername || socket.id,
              x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
              hp: data.breakable === false ? null : 2 };  // erasable/destructible like other props
    } else {
      // Unified PLATFORM: a solid one-way bar with optional rotation, modifiers, and a motion path.
      // Modifiers absorb the old props: bouncy (jump pad), boost (conveyor/booster/ramp — signed
      // strength), updraft (fan). A `path` makes it move; live position is derived client-side from
      // the wall clock + a phase fraction, so only the static descriptor is stored/replayed.
      if (!isFinite(data.x) || !isFinite(data.y)) return;
      obj = { id, type: 'platform', ownerId: socket.id, owner: currentUsername || socket.id,
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
    if (map.size >= MAX_OBJECTS_PER_ROOM) {                 // FIFO eviction
      const oldest = map.keys().next().value;
      map.delete(oldest);
      io.to(currentRoom).emit('avatar-object-removed', { id: oldest });
    }
    map.set(id, obj);
    io.to(currentRoom).emit('avatar-object-add', obj);     // whole room incl. sender (authoritative id)
  });
  // Mouse-eraser removal: only the OWNER may delete their own object this way. (Physically
  // destroying anyone's object goes through avatar-object-hit, which is unrestricted.)
  socket.on('avatar-object-remove', ({ id }) => {
    if (!currentRoom || !roomObjects[currentRoom]) return;
    const obj = roomObjects[currentRoom].get(id);
    // Owner by stable username (survives reconnect/new socket.id) OR the live socket.id.
    if (!obj || !(obj.ownerId === socket.id || (obj.owner && obj.owner === currentUsername))) return;
    roomObjects[currentRoom].delete(id);
    io.to(currentRoom).emit('avatar-object-removed', { id });
  });
  // Bulk-remove all of MY own objects (the Erase tool's "Remove all mine" button). Owner-scoped,
  // like the single mouse-eraser, but in one round-trip.
  socket.on('avatar-objects-remove-mine', () => {
    if (!currentRoom || !roomObjects[currentRoom]) return;
    const map = roomObjects[currentRoom], ids = [];
    for (const [id, o] of map) if (o.ownerId === socket.id || (o.owner && o.owner === currentUsername)) ids.push(id);
    for (const id of ids) map.delete(id);
    if (ids.length) io.to(currentRoom).emit('avatar-objects-removed', { ids });
  });
  // Debug: wipe the WHOLE environment for everyone in the room (clears all owners' objects).
  socket.on('avatar-objects-clear-all', () => {
    if (!currentRoom) return;
    if (roomObjects[currentRoom]) {
      const map = roomObjects[currentRoom], ids = [...map.keys()];
      map.clear();
      if (ids.length) io.to(currentRoom).emit('avatar-objects-removed', { ids });
    }
    if (roomTerrain[currentRoom]) { roomTerrain[currentRoom].fill(0); io.to(currentRoom).emit('terrain-cleared'); }
  });
  // Damage a destructible object (client-authoritative hit). Decrement hp; broadcast the new
  // hp, or remove it at 0. Server owns hp so concurrent hits can't double-count past zero.
  // Destructible terrain: paint/carve a circle into the room grid, then rebroadcast the op so every
  // client rasterizes it identically (client also applies optimistically). Only echoes on a real change.
  socket.on('terrain-edit', ({ op, x, y, r, mat }) => {
    if (!currentRoom || (op !== 'paint' && op !== 'carve')) return;
    if (!isFinite(x) || !isFinite(y) || !isFinite(r)) return;
    const cx = Math.max(0, Math.min(MWSim.C.WORLD_W, x)), cy = Math.max(0, Math.min(MWSim.C.WORLD_H, y));
    const rr = Math.max(8, Math.min(160, r));
    const m = (op === 'paint') ? (Math.min(TERRAIN_MAT_MAX, Math.max(1, mat | 0)) || 1) : 0;  // material id 1..MAX (carve = 0)
    const grid = ensureTerrain(currentRoom);
    if (rasterTerrainCircle(grid, cx, cy, rr, m))
      io.to(currentRoom).emit('terrain-edited', { op, x: cx, y: cy, r: rr, mat: m });
  });
  socket.on('avatar-object-hit', ({ id, dmg }) => {
    if (!currentRoom || !roomObjects[currentRoom]) return;
    const obj = roomObjects[currentRoom].get(id);
    if (!obj || typeof obj.hp !== 'number') return;
    obj.hp -= (typeof dmg === 'number' && dmg > 0) ? Math.min(dmg, 99) : 1;
    if (obj.hp <= 0) { roomObjects[currentRoom].delete(id); io.to(currentRoom).emit('avatar-object-removed', { id }); }
    else io.to(currentRoom).emit('avatar-object-update', { id, hp: obj.hp });
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

  socket.on('disconnect', () => {
    if (currentRoom) {
      delete roomUsers[currentRoom][socket.id];
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
      if (roomAvt[currentRoom] && roomAvt[currentRoom].delete(socket.id)) {
        socket.to(currentRoom).emit('avt-peer-left', { id: socket.id });
      }
      broadcastPresence(currentRoom);
      io.to(currentRoom).emit('cursor-leave', { id: socket.id });
      io.to(currentRoom).emit('avatar-leave', { id: socket.id });
    }
    if (socketDmRooms[socket.id]) {
      for (const roomId of socketDmRooms[socket.id]) {
        socket.to(roomId).emit('dm-user-left', { roomId, from: currentUsername });
      }
      delete socketDmRooms[socket.id];
    }
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
