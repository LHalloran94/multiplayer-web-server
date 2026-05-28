const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const roomUsers = {};    // { roomName: { socketId: username } }
const roomHistory = {};
const MAX_HISTORY = 50;

function broadcastPresence(room) {
  const users = Object.values(roomUsers[room] || {});
  io.to(room).emit('presence', { count: users.length, users });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ url, username }) => {
    currentRoom = url;
    socket.join(currentRoom);

    if (!roomUsers[currentRoom]) roomUsers[currentRoom] = {};
    roomUsers[currentRoom][socket.id] = username;

    if (roomHistory[currentRoom]) {
      socket.emit('history', roomHistory[currentRoom]);
    }

    broadcastPresence(currentRoom);

    socket.to(currentRoom).emit('message', {
      system: true,
      text: `${username} joined`
    });
  });

  socket.on('message', ({ text, username }) => {
    if (!currentRoom) return;
    const msg = { username, text, timestamp: Date.now() };
    if (!roomHistory[currentRoom]) roomHistory[currentRoom] = [];
    roomHistory[currentRoom].push(msg);
    if (roomHistory[currentRoom].length > MAX_HISTORY) {
      roomHistory[currentRoom].shift();
    }
    io.to(currentRoom).emit('message', msg);
  });

  socket.on('cursor', ({ x, y, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor', { x, y, username, id: socket.id });
  });

  socket.on('reaction', ({ emoji, x, y, username }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('reaction', { emoji, x, y, username, id: socket.id });
  });

  socket.on('highlight', ({ text, selector, username }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('highlight', { text, selector, username });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      delete roomUsers[currentRoom][socket.id];
      broadcastPresence(currentRoom);
      io.to(currentRoom).emit('cursor-leave', { id: socket.id });
    }
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));