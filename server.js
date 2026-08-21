const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Track connected users per room
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join', ({ room, name }) => {
    currentRoom = room || 'main';
    currentName = name || 'Agent';

    socket.join(currentRoom);

    if (!rooms[currentRoom]) rooms[currentRoom] = {};
    rooms[currentRoom][socket.id] = currentName;

    // Notify others in the room
    socket.to(currentRoom).emit('system', `${currentName} has entered the room.`);

    // Send current member list to everyone in the room
    io.to(currentRoom).emit('members', Object.values(rooms[currentRoom]));

    // Tell existing members a new peer joined (for WebRTC)
    socket.to(currentRoom).emit('peer-joined', { id: socket.id, name: currentName });
  });

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', {
      name: currentName,
      text: msg,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // WebRTC signaling relay
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // A client announces it just went live on voice; tell other room members
  // so any of them that are already live can initiate a call to this new peer.
  socket.on('voice-ready', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('voice-ready', { id: socket.id, name: currentName });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][socket.id];
      socket.to(currentRoom).emit('system', `${currentName} has left the room.`);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      io.to(currentRoom).emit('members', Object.values(rooms[currentRoom]));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Spy Chat running on port ${PORT}`);
});
