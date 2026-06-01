const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

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
const db = new DatabaseSync(process.env.DB_PATH || './db.sqlite');
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
    const row = db.prepare('SELECT discord_id, username, avatar, bio, status FROM users WHERE discord_id = ?').get(req.params.discordId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.put('/profile', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { bio, status } = req.body;
  try {
    db.prepare('UPDATE users SET bio = ?, status = ?, updated_at = unixepoch() WHERE discord_id = ?')
      .run((bio || '').slice(0, 160) || null, (status || '').slice(0, 60) || null, user.sub);
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
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const id = generateRoomCode();
    const trimmed = name.trim().slice(0, 40);
    db.prepare('INSERT INTO rooms (id, name, owner_id) VALUES (?, ?, ?)').run(id, trimmed, user.sub);
    db.prepare('INSERT INTO room_members (room_id, discord_id) VALUES (?, ?)').run(id, user.sub);
    res.json({ id, name: trimmed, owner_id: user.sub, member_count: 1 });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id,
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
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(id, user.sub);
    if (!member) return res.status(403).json({ error: 'Not a member' });
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
const roomAnnotations = {};
const roomSprays = {};
const roomMedia = {};
const roomAvatars = {};
const roomVoice = {};
const userCurrentFullUrl = {};
const socketDmRooms = {};      // socketId → Set of DM roomIds
const socketToDiscordId = {};  // socketId → discordId
const discordIdToSocket = {};  // discordId → socketId
const discordIdToFullUrl = {}; // discordId → current full URL
const MAX_HISTORY = 50;
const MAX_SPRAYS = 50;
const MAX_MEDIA = 30;

function broadcastPresence(room) {
  const users = Object.values(roomUsers[room] || {});
  io.to(room).emit('presence', { count: users.length, users });
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;

  socket.on('join', ({ url, fullUrl, username, token }) => {
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
        discordIdToFullUrl[discordId] = fullUrl || url;
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
        acceptedFriends.forEach(r => {
          const fs = discordIdToSocket[r.fid];
          if (fs) io.to(fs).emit('friend-online', { discord_id: discordId, username, avatar, url: fullUrl || url });
        });
        const friendsData = db.prepare(`
          SELECT u.discord_id, u.username, u.avatar, f.status,
                 CASE WHEN f.from_id=? THEN 0 ELSE 1 END as incoming
          FROM friends f
          JOIN users u ON u.discord_id = CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END
          WHERE f.from_id=? OR f.to_id=?
        `).all(discordId, discordId, discordId, discordId)
          .map(r => ({ ...r, incoming: !!r.incoming, online: !!discordIdToSocket[r.discord_id], url: discordIdToFullUrl[r.discord_id] || null }));
        socket.emit('friends-init', friendsData);
      } catch (e) { console.error('[friends-init]', e); }

      // Private rooms
      try {
        const userRooms = db.prepare(`
          SELECT r.id, r.name, r.owner_id,
                 (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
          FROM rooms r
          JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
          ORDER BY r.created_at ASC
        `).all(discordId);
        socket.emit('private-rooms-init', userRooms);
      } catch (e) { console.error('[private-rooms-init]', e); }
    }

    console.log(`[join] ${username} (verified:${verified}) joined room: ${currentRoom}`);
  });

  socket.on('message', ({ text, username }) => {
    if (!currentRoom) return;
    const msg = { username, text, timestamp: Date.now() };
    if (!roomHistory[currentRoom]) roomHistory[currentRoom] = [];
    roomHistory[currentRoom].push(msg);
    if (roomHistory[currentRoom].length > MAX_HISTORY) roomHistory[currentRoom].shift();
    io.to(currentRoom).emit('message', msg);
  });

  socket.on('cursor', ({ x, y, scrollPct, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor', { x, y, scrollPct, username, id: socket.id });
  });

  socket.on('pointer-pulse', ({ x, y, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('pointer-pulse', { x, y, username });
  });

  socket.on('reaction', ({ emoji, x, y, username, source }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('reaction', { emoji, x, y, username, source });
  });

  socket.on('soundboard', ({ soundIndex, label, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('soundboard', { soundIndex, label, username });
  });

  socket.on('highlight', ({ text, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('highlight', { text, username });
  });

  socket.on('annotation-add', ({ id, selector, offsetX, offsetY, text, username }) => {
    if (!currentRoom) return;
    const annotation = { id, selector, offsetX, offsetY, text, username, timestamp: Date.now() };
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

  socket.on('spray-add', ({ id, content, size, docX, docY, username }) => {
    if (!currentRoom) return;
    const spray = { id, content, size, docX, docY, username, timestamp: Date.now() };
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

  socket.on('avatar-move', ({ x, y, username, facingLeft, onGround, fill }) => {
    if (!currentRoom) return;
    if (!roomAvatars[currentRoom]) roomAvatars[currentRoom] = {};
    roomAvatars[currentRoom][socket.id] = { id: socket.id, x, y, username, facingLeft, onGround, fill };
    socket.to(currentRoom).emit('avatar-move', { id: socket.id, x, y, username, facingLeft, onGround, fill });
  });

  socket.on('voice-join', ({ username }) => {
    if (!currentRoom) return;
    if (!roomVoice[currentRoom]) roomVoice[currentRoom] = {};
    const existingPeers = Object.keys(roomVoice[currentRoom]);
    roomVoice[currentRoom][socket.id] = username;
    socket.emit('voice-joined', { existingPeers });
    io.to(currentRoom).emit('voice-peer-joined', { id: socket.id, username });
  });

  socket.on('voice-leave', () => {
    if (!currentRoom || !roomVoice[currentRoom]) return;
    delete roomVoice[currentRoom][socket.id];
    io.to(currentRoom).emit('voice-peer-left', { id: socket.id });
  });

  socket.on('voice-offer',      ({ to, sdp })       => { socket.to(to).emit('voice-offer',    { from: socket.id, sdp }); });
  socket.on('voice-answer',     ({ to, sdp })       => { socket.to(to).emit('voice-answer',   { from: socket.id, sdp }); });
  socket.on('voice-ice',        ({ to, candidate }) => { socket.to(to).emit('voice-ice',      { from: socket.id, candidate }); });
  socket.on('voice-speaking',   ()                  => { if (currentRoom) socket.to(currentRoom).emit('voice-speaking', { id: socket.id }); });

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
    if (!senderDiscordId || !roomId || !text) return;
    try {
      const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(roomId, senderDiscordId);
      if (!member) return;
      const senderUser = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(senderDiscordId);
      const username = senderUser?.username || currentUsername;
      const ts = Date.now();
      db.prepare('INSERT INTO room_messages (room_id, from_discord_id, text, sent_at) VALUES (?, ?, ?, ?)').run(roomId, senderDiscordId, text.slice(0, 2000), ts);
      socket.to('proom:' + roomId).emit('private-room-message', { roomId, from: username, fromDiscordId: senderDiscordId, text, timestamp: ts });
    } catch (e) { console.error('[private-room-message]', e); }
  });

  socket.on('nav', ({ url, username }) => {
    if (currentRoom) socket.to(currentRoom).emit('nav', { url, username });
    const dId = socketToDiscordId[socket.id];
    if (dId && url) {
      discordIdToFullUrl[dId] = url;
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
    }
  });
  socket.on('follow-start',     ({ target })        => { if (currentRoom) socket.to(currentRoom).emit('follow-start', { target, from: currentUsername || '' }); });
  socket.on('follow-end',       ({ target })        => { if (currentRoom) socket.to(currentRoom).emit('follow-end',   { target, from: currentUsername || '' }); });

  socket.on('follow-subscribe', ({ target }) => {
    socket.join('user:' + target);
    if (userCurrentFullUrl[target]) socket.emit('user-location', { url: userCurrentFullUrl[target] });
  });
  socket.on('follow-unsubscribe', ({ target }) => { socket.leave('user:' + target); });

  socket.on('disconnect', () => {
    if (currentRoom) {
      delete roomUsers[currentRoom][socket.id];
      if (roomAvatars[currentRoom]) delete roomAvatars[currentRoom][socket.id];
      if (roomVoice[currentRoom] && roomVoice[currentRoom][socket.id]) {
        delete roomVoice[currentRoom][socket.id];
        io.to(currentRoom).emit('voice-peer-left', { id: socket.id });
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
