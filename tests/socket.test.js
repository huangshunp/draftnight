const test = require('node:test');
const assert = require('node:assert/strict');
const { io: Client } = require('socket.io-client');
const { server, io, rooms } = require('../server/index');

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function connectClient(url) {
  const socket = Client(url, { forceNew: true });
  await once(socket, 'connect');
  return socket;
}

function me(state) {
  return state.players.find((player) => player.id === state.playerId);
}

async function finishDraft(sockets, sessions, latest) {
  let state = latest[0];
  while (state.phase === 'draft') {
    const playerIndex = sessions.findIndex((session) => session.playerId === state.currentPlayerId);
    const socket = sockets[playerIndex];
    const slotId = state.draft.pool.find((slot) => !slot.revealedTo || slot.revealedTo === state.currentPlayerId)?.slotId;
    assert.ok(slotId);
    const revealed = await emit(socket, 'revealDraft', { slotId, actionId: `reveal-${slotId}` });
    assert.equal(revealed.ok, true, revealed.error);
    const chosen = await emit(socket, 'chooseDraft', { slotId, want: true, actionId: `choose-${slotId}` });
    assert.equal(chosen.ok, true, chosen.error);
    state = chosen.state;
  }
  return state;
}

test('public socket rooms enforce network multiplayer rules and private state', async (t) => {
  rooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${url}/health`).then((res) => res.json());
  assert.deepEqual(health, { ok: true });

  const sockets = [];
  const latest = [];
  const sessions = [];
  for (let i = 0; i < 4; i += 1) {
    const socket = await connectClient(url);
    const index = sockets.length;
    socket.on('state', (state) => {
      latest[index] = state;
    });
    socket.on('session', (session) => {
      sessions[index] = session;
    });
    sockets.push(socket);
  }
  t.after(() => sockets.forEach((socket) => socket.close()));

  const created = await emit(sockets[0], 'createRoom', { name: 'A' });
  assert.equal(created.ok, true);
  assert.match(created.state.code, /^[A-Z2-9]{6}$/);
  const code = created.state.code;

  const joinedB = await emit(sockets[1], 'joinRoom', { code, name: 'A' });
  assert.equal(joinedB.ok, true);
  assert.notEqual(joinedB.state.players[0].name, joinedB.state.players[1].name);
  assert.equal((await emit(sockets[2], 'joinRoom', { code, name: 'C' })).ok, true);

  const rejected = await emit(sockets[3], 'joinRoom', { code, name: 'D' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /房间已满/);

  const invalidResume = await emit(sockets[3], 'resume', {
    roomCode: code,
    playerId: sessions[0].playerId,
    playerToken: 'not-the-token'
  });
  assert.equal(invalidResume.ok, false);
  assert.match(invalidResume.error, /无法恢复/);

  assert.equal((await emit(sockets[1], 'startGame', { actionId: 'non-host-start' })).ok, false);
  assert.equal((await emit(sockets[0], 'setReady', { ready: true, actionId: 'ready-a' })).ok, true);
  assert.equal((await emit(sockets[1], 'setReady', { ready: true, actionId: 'ready-b' })).ok, true);
  const notReady = await emit(sockets[0], 'startGame', { actionId: 'too-early' });
  assert.equal(notReady.ok, false);
  assert.match(notReady.error, /所有玩家准备/);
  assert.equal((await emit(sockets[2], 'setReady', { ready: true, actionId: 'ready-c' })).ok, true);
  const started = await emit(sockets[0], 'startGame', { actionId: 'host-start' });
  assert.equal(started.ok, true);
  assert.equal(started.state.phase, 'draft');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const aViewOfB = latest[0].players.find((player) => player.id === sessions[1].playerId);
  assert.equal(aViewOfB.hand, undefined);
  assert.equal(aViewOfB.handCount > 0, true);

  const otherRoom = await connectClient(url);
  t.after(() => otherRoom.close());
  let otherRoomState;
  otherRoom.on('state', (state) => {
    otherRoomState = state;
  });
  const createdOther = await emit(otherRoom, 'createRoom', { name: 'Z' });
  assert.equal(createdOther.ok, true);
  assert.notEqual(createdOther.state.code, code);
  assert.equal(otherRoomState.players.length, 1);

  const finishedDraft = await finishDraft(sockets, sessions, latest);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const turnState = finishedDraft;
  const currentIndex = sessions.findIndex((session) => session.playerId === turnState.currentPlayerId);
  const nonCurrentIndex = currentIndex === 0 ? 1 : 0;
  const nonCurrent = me(latest[nonCurrentIndex]);
  const illegalTurn = await emit(sockets[nonCurrentIndex], 'sign', {
    cardId: nonCurrent.hand[0].id,
    salary: 1,
    score: 99,
    cash: 999,
    actionId: 'not-current'
  });
  assert.equal(illegalTurn.ok, false);
  assert.match(illegalTurn.error, /还没轮到/);

  const current = me(latest[currentIndex]);
  const cashBefore = current.cash;
  const forged = await emit(sockets[currentIndex], 'sign', {
    cardId: current.hand[0].id,
    salary: 1,
    score: 999,
    cash: 999,
    actionId: 'sign-once'
  });
  assert.equal(forged.ok, true);
  const afterSign = me(forged.state);
  assert.equal(afterSign.cash, cashBefore - 1);
  assert.notEqual(afterSign.signed[0].card.score, 999);

  const duplicate = await emit(sockets[currentIndex], 'sign', {
    cardId: afterSign.hand[0]?.id,
    salary: 1,
    actionId: 'sign-once'
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(me(duplicate.state).cash, cashBefore - 1);

  sockets[0].disconnect();
  const replacement = await connectClient(url);
  t.after(() => replacement.close());
  const resumed = await emit(replacement, 'resume', sessions[0]);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.playerId, sessions[0].playerId);

  const room = rooms.get(code);
  room.status = 'ended';
  room.draft = null;
  room.results = room.players.map((player) => ({ playerId: player.id, score: 0, winner: true }));
  const endedOperation = await emit(sockets[currentIndex], 'endTurn', { actionId: 'after-ended' });
  assert.equal(endedOperation.ok, false);
  assert.match(endedOperation.error, /当前不能执行|不在进行/);

  const hostIndex = sessions.findIndex((session) => session.playerId === room.hostId);
  const restarted = await emit(sockets[hostIndex], 'restart', { actionId: 'restart-room' });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.state.phase, 'lobby');
  assert.equal(restarted.state.deckCount, 0);
  assert.equal(restarted.state.discardCount, 0);
  assert.ok(restarted.state.players.every((player) => player.handCount === 0));
});

test('players can leave lobby seats and host can cancel rooms', async (t) => {
  rooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `http://127.0.0.1:${server.address().port}`;
  const host = await connectClient(url);
  const guest = await connectClient(url);
  const replacement = await connectClient(url);
  t.after(() => {
    host.close();
    guest.close();
    replacement.close();
  });

  let closedMessage;
  const created = await emit(host, 'createRoom', { name: 'Host' });
  assert.equal(created.ok, true);
  const code = created.state.code;
  assert.equal((await emit(guest, 'joinRoom', { code, name: 'Guest' })).ok, true);

  const left = await emit(guest, 'leaveRoom');
  assert.equal(left.ok, true);
  assert.equal(left.left, true);
  replacement.on('roomClosed', (message) => {
    closedMessage = message;
  });
  assert.equal((await emit(replacement, 'joinRoom', { code, name: 'Replacement' })).ok, true);

  const canceled = await emit(host, 'leaveRoom');
  assert.equal(canceled.ok, true);
  assert.equal(canceled.closed, true);
  assert.equal(rooms.has(code), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closedMessage.roomCode, code);

  const lateJoiner = await connectClient(url);
  t.after(() => lateJoiner.close());
  const rejected = await emit(lateJoiner, 'joinRoom', { code, name: 'Late' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /房间不存在/);
});
