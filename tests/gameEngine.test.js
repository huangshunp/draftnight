const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../server/gameEngine');

function fixedRng() {
  return 0;
}

function readyRoom(count = 2) {
  const { room, host } = engine.createRoom('A');
  const players = [host];
  for (let i = 1; i < count; i += 1) {
    players.push(engine.addPlayer(room, String.fromCharCode(65 + i)));
  }
  players.forEach((player) => engine.setReady(room, player.id, true));
  engine.startGame(room, fixedRng);
  return { room, players };
}

function finishDraft(room) {
  while (room.draft) {
    const playerId = room.draft.order[room.draft.cursor];
    const slot = room.draft.pool.find((entry) => !entry.takenBy);
    engine.revealDraft(room, playerId, slot.slotId);
    engine.chooseDraft(room, playerId, slot.slotId, true, fixedRng);
  }
}

test('room code is six characters and duplicate names are made unique', () => {
  const { room } = engine.createRoom('同名');
  engine.addPlayer(room, '同名');
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.notEqual(room.players[0].name, room.players[1].name);
});

test('viewFor never exposes other players hands or hidden draft cards', () => {
  const { room, players } = readyRoom(3);
  const viewA = engine.viewFor(room, players[0].id);
  const viewB = engine.viewFor(room, players[1].id);

  assert.ok(viewA.players.find((p) => p.id === players[0].id).hand.length > 0);
  assert.equal(viewA.players.find((p) => p.id === players[1].id).hand, undefined);
  assert.equal(viewB.players.find((p) => p.id === players[0].id).hand, undefined);
  assert.ok(viewA.draft.pool.every((slot) => slot.card === null));
});

test('non-current players cannot act and a turn action can run only once', () => {
  const { room, players } = readyRoom(2);
  finishDraft(room);
  const current = engine.currentPlayer(room);
  const other = players.find((p) => p.id !== current.id);
  const card = current.hand[0];

  assert.throws(() => engine.signCard(room, other.id, other.hand[0].id, 1), /还没轮到/);
  engine.signCard(room, current.id, card.id, 1);
  assert.equal(current.actionsUsed.sign, true);
  assert.throws(() => engine.signCard(room, current.id, current.hand[0].id, 1), /已经执行过/);
});

test('clients cannot operate cards they do not own or forge server-owned values', () => {
  const { room, players } = readyRoom(2);
  finishDraft(room);
  const current = engine.currentPlayer(room);
  const other = players.find((p) => p.id !== current.id);
  const cashBefore = current.cash;

  assert.throws(() => engine.signCard(room, current.id, other.hand[0].id, 1), /不属于自己/);
  assert.throws(() => engine.trade(room, current.id, other.id, other.hand[0].id, fixedRng), /不属于自己/);
  assert.throws(() => engine.signCard(room, current.id, current.hand[0].id, 999), /钞票不足/);
  assert.equal(current.cash, cashBefore);
  assert.equal(current.signed.length, 0);
});

test('restart clears old deck, hands, discards, results, and action state', () => {
  const { room, players } = readyRoom(2);
  finishDraft(room);
  const current = engine.currentPlayer(room);
  engine.signCard(room, current.id, current.hand[0].id, 1);
  room.recentActions.set(`${current.id}:sign:test`, { ok: true });
  room.discard.push({ id: 'old-card', score: 1 });
  room.status = 'ended';
  room.results = [{ playerId: players[0].id, score: 1, winner: true }];

  engine.restart(room);

  assert.equal(room.status, 'lobby');
  assert.equal(room.deck.length, 0);
  assert.equal(room.discard.length, 0);
  assert.equal(room.draft, null);
  assert.equal(room.results, null);
  assert.equal(room.recentActions.size, 0);
  assert.ok(room.players.every((player) => player.hand.length === 0 && player.signed.length === 0));
  assert.ok(room.players.every((player) => Object.values(player.actionsUsed).every((used) => used === false)));
});
