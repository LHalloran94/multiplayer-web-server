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

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';

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

const roomUsers = {};       // roomId → { socketId: { username, verified, avatar } }
const roomHistory = {};
const roomAnnotations = {};
const roomSprays = {};
const roomMedia = {};
const roomAvatars = {};
const roomVoice = {};
const userCurrentFullUrl = {};
const socketDmRooms = {};   // socketId → Set of DM roomIds
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

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        avatar = decoded.avatar || null;
        verified = true;
        // Fall back to Discord username only if client sent nothing
        if (!username || !username.trim()) username = decoded.username;
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
    roomUsers[currentRoom][socket.id] = { username, verified, avatar };
    if (roomHistory[currentRoom]) socket.emit('history', roomHistory[currentRoom]);
    if (roomAnnotations[currentRoom]) socket.emit('annotations-init', roomAnnotations[currentRoom]);
    if (roomSprays[currentRoom]) socket.emit('sprays-init', roomSprays[currentRoom]);
    if (roomMedia[currentRoom]) socket.emit('media-init', roomMedia[currentRoom]);
    if (roomAvatars[currentRoom]) socket.emit('avatars-init', Object.values(roomAvatars[currentRoom]));
    if (roomVoice[currentRoom] && Object.keys(roomVoice[currentRoom]).length) socket.emit('voice-init', roomVoice[currentRoom]);
    broadcastPresence(currentRoom);
    socket.to(currentRoom).emit('message', { system: true, text: `${username} joined` });
    socket.to('user:' + username).emit('user-location', { url: userCurrentFullUrl[username] });
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

  socket.on('dm-open', ({ to, roomId, text }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!socketDmRooms[socket.id]) socketDmRooms[socket.id] = new Set();
    socketDmRooms[socket.id].add(roomId);
    const payload = { from: currentUsername, roomId };
    if (text) payload.firstMessage = { text, timestamp: Date.now() };
    socket.to('user:' + to).emit('dm-incoming', payload);
  });

  socket.on('dm-join', ({ roomId }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!socketDmRooms[socket.id]) socketDmRooms[socket.id] = new Set();
    socketDmRooms[socket.id].add(roomId);
  });

  socket.on('dm-message', ({ roomId, from, text }) => {
    if (!roomId || !text) return;
    socket.to(roomId).emit('dm-message', { roomId, from, text, timestamp: Date.now() });
  });
  socket.on('nav',              ({ url, username }) => { if (currentRoom) socket.to(currentRoom).emit('nav', { url, username }); });
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
    if (currentUsername) delete userCurrentFullUrl[currentUsername];
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
