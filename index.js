const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const roomUsers = {};
const roomHistory = {};  // NEW: stores recent messages per room
const MAX_HISTORY = 50;  // keep last 50 messages

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ url, username }) => {
    currentRoom = url;
    socket.join(currentRoom);

    // Send existing history to the person who just joined
    if (roomHistory[currentRoom]) {
      socket.emit('history', roomHistory[currentRoom]);
    }

    roomUsers[currentRoom] = (roomUsers[currentRoom] || 0) + 1;
    io.to(currentRoom).emit('presence', { count: roomUsers[currentRoom] });

    socket.to(currentRoom).emit('message', {
      system: true,
      text: `${username} joined`
    });
  });

  socket.on('message', ({ text, username }) => {
    if (!currentRoom) return;

    const msg = { username, text, timestamp: Date.now() };

    // Save to history
    if (!roomHistory[currentRoom]) roomHistory[currentRoom] = [];
    roomHistory[currentRoom].push(msg);
    if (roomHistory[currentRoom].length > MAX_HISTORY) {
      roomHistory[currentRoom].shift(); // drop oldest if over limit
    }

    io.to(currentRoom).emit('message', msg);
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      roomUsers[currentRoom] = Math.max(0, (roomUsers[currentRoom] || 1) - 1);
      io.to(currentRoom).emit('presence', { count: roomUsers[currentRoom] });
    }
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));