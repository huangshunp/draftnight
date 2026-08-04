const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const engine = require('./gameEngine');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const app = express();
app.use(express.json());
app.use('/cards', express.static(path.join(__dirname, '..', 'assets', 'cards')));
app.use('/background', express.static(path.join(__dirname, '..', 'assets', 'background')));
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use('/manual', express.static(path.join(__dirname, '..', 'public', 'manual')));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

function emitRoom(room) {
  for (const player of room.players) {
    for (const socketId of io.sockets.adapter.rooms.get(player.id) || []) {
      io.to(socketId).emit('state', engine.viewFor(room, player.id));
    }
  }
}

function emitError(socket, message) {
  socket.emit('errorMessage', String(message || '操作失败。'));
}

function bindPlayer(socket, room, player) {
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  player.connected = true;
  bumpVersion(room);
  socket.join(room.code);
  socket.join(player.id);
  socket.emit('session', { roomCode: room.code, playerId: player.id, playerToken: player.token });
  emitRoom(room);
}

function roomByCode(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function requireSession(socket) {
  const room = roomByCode(socket.data.roomCode);
  if (!room) throw new Error('房间不存在。');
  const player = room.players.find((p) => p.id === socket.data.playerId);
  if (!player) throw new Error('身份无效。');
  return { room, player };
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name } = {}, reply) => {
    try {
      let created;
      do {
        created = engine.createRoom(name);
      } while (rooms.has(created.room.code));
      rooms.set(created.room.code, created.room);
      bindPlayer(socket, created.room, created.host);
      reply?.({ ok: true, state: engine.viewFor(created.room, created.host.id) });
    } catch (error) {
      emitError(socket, error.message);
      reply?.({ ok: false, error: error.message });
    }
  });

  socket.on('joinRoom', ({ code, name } = {}, reply) => {
    try {
      const room = roomByCode(code);
      if (!room) throw new Error('房间不存在。');
      const player = engine.addPlayer(room, name);
      bindPlayer(socket, room, player);
      reply?.({ ok: true, state: engine.viewFor(room, player.id) });
    } catch (error) {
      emitError(socket, error.message);
      reply?.({ ok: false, error: error.message });
    }
  });

  socket.on('leaveRoom', (_payload = {}, reply) => {
    try {
      const { room, player } = requireSession(socket);
      if (room.hostId === player.id) {
        closeRoom(room, '房主已取消房间。');
        reply?.({ ok: true, closed: true });
        return;
      }
      if (room.status === 'lobby') {
        engine.removePlayer(room, player.id);
      } else {
        player.connected = false;
      }
      clearSocketSession(socket, room.code, player.id);
      bumpVersion(room);
      emitRoom(room);
      reply?.({ ok: true, left: true });
    } catch (error) {
      emitError(socket, error.message);
      reply?.({ ok: false, error: error.message });
    }
  });

  socket.on('resume', ({ roomCode, playerId, playerToken, token } = {}, reply) => {
    try {
      const room = roomByCode(roomCode);
      if (!room) throw new Error('房间不存在。');
      const player = room.players.find((p) => p.id === playerId && p.token === (playerToken || token));
      if (!player) throw new Error('无法恢复身份，请重新加入。');
      bindPlayer(socket, room, player);
      reply?.({ ok: true, state: engine.viewFor(room, player.id) });
    } catch (error) {
      emitError(socket, error.message);
      reply?.({ ok: false, error: error.message });
    }
  });

  socket.on('setReady', (payload = {}, reply) => action(socket, reply, 'setReady', payload, (room, player) => {
    const { ready } = payload;
    engine.setReady(room, player.id, ready);
  }));

  socket.on('startGame', (payload = {}, reply) => action(socket, reply, 'startGame', payload, (room, player) => {
    engine.ensureHost(room, player.id);
    engine.startGame(room);
  }));

  socket.on('revealDraft', (payload = {}, reply) => action(socket, reply, 'revealDraft', payload, (room, player) => {
    const { slotId } = payload;
    engine.revealDraft(room, player.id, slotId);
  }));

  socket.on('chooseDraft', (payload = {}, reply) => action(socket, reply, 'chooseDraft', payload, (room, player) => {
    const { slotId, want } = payload;
    engine.chooseDraft(room, player.id, slotId, Boolean(want));
  }));

  socket.on('sign', (payload = {}, reply) => action(socket, reply, 'sign', payload, (room, player) => {
    const { cardId, salary } = payload;
    engine.signCard(room, player.id, cardId, salary);
  }));

  socket.on('trade', (payload = {}, reply) => action(socket, reply, 'trade', payload, (room, player) => {
    const { targetId, offeredCardId } = payload;
    engine.trade(room, player.id, targetId, offeredCardId);
  }));

  socket.on('poach', (payload = {}, reply) => action(socket, reply, 'poach', payload, (room, player) => {
    const { targetId, cardId, salary } = payload;
    engine.poach(room, player.id, targetId, cardId, salary);
  }));

  socket.on('endTurn', (payload = {}, reply) => action(socket, reply, 'endTurn', payload, (room, player) => {
    engine.endTurn(room, player.id);
  }));

  socket.on('restart', (payload = {}, reply) => action(socket, reply, 'restart', payload, (room, player) => {
    engine.ensureHost(room, player.id);
    engine.restart(room);
  }));

  socket.on('disconnect', () => {
    const room = roomByCode(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return;
    const sockets = io.sockets.adapter.rooms.get(player.id);
    player.connected = Boolean(sockets && sockets.size > 0);
    engine.transferHostIfNeeded(room);
    bumpVersion(room);
    emitRoom(room);
  });
});

function closeRoom(room, reason) {
  const socketIds = Array.from(io.sockets.adapter.rooms.get(room.code) || []);
  for (const socketId of socketIds) {
    const roomSocket = io.sockets.sockets.get(socketId);
    if (!roomSocket) continue;
    roomSocket.emit('roomClosed', { roomCode: room.code, reason });
    clearSocketSession(roomSocket, room.code, roomSocket.data.playerId);
  }
  rooms.delete(room.code);
}

function clearSocketSession(socket, roomCode, playerId) {
  socket.leave(roomCode);
  if (playerId) socket.leave(playerId);
  delete socket.data.roomCode;
  delete socket.data.playerId;
}

function action(socket, reply, eventName, payload, fn) {
  try {
    const { room, player } = requireSession(socket);
    const actionId = normalizeActionId(payload?.actionId);
    const actionKey = actionId ? `${player.id}:${eventName}:${actionId}` : null;
    if (actionKey && room.recentActions?.has(actionKey)) {
      const cached = room.recentActions.get(actionKey);
      reply?.({ ...cached, state: engine.viewFor(room, player.id), duplicate: true });
      return;
    }
    fn(room, player);
    bumpVersion(room);
    emitRoom(room);
    const result = { ok: true, state: engine.viewFor(room, player.id) };
    rememberAction(room, actionKey, { ok: true });
    reply?.(result);
  } catch (error) {
    emitError(socket, error.message);
    reply?.({ ok: false, error: error.message });
  }
}

function bumpVersion(room) {
  room.stateVersion = (room.stateVersion || 1) + 1;
}

function normalizeActionId(actionId) {
  if (!actionId) return null;
  return String(actionId).slice(0, 128);
}

function rememberAction(room, actionKey, result) {
  if (!actionKey) return;
  if (!room.recentActions) room.recentActions = new Map();
  room.recentActions.set(actionKey, result);
  while (room.recentActions.size > 200) {
    room.recentActions.delete(room.recentActions.keys().next().value);
  }
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { app, server, io, rooms };
