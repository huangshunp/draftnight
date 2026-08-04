const crypto = require('crypto');

const POSITIONS = {
  guard: '后卫',
  forward: '前锋',
  center: '中锋'
};

const ACTIONS = ['sign', 'trade', 'poach'];

function newId(prefix = '') {
  return `${prefix}${crypto.randomBytes(6).toString('hex')}`;
}

function randomInt(max) {
  return crypto.randomInt(max);
}

function buildDeck() {
  return Object.keys(POSITIONS).flatMap((position) =>
    Array.from({ length: 10 }, (_, index) => {
      const score = index + 1;
      return {
        id: `${position}-${String(score).padStart(2, '0')}`,
        position,
        positionName: POSITIONS[position],
        score,
        image: `/cards/${position}-${String(score).padStart(2, '0')}.png`
      };
    })
  );
}

function shuffle(cards, rng = randomInt) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom(hostName = '玩家1') {
  const room = {
    code: makeRoomCode(),
    status: 'lobby',
    stateVersion: 1,
    hostId: null,
    createdAt: Date.now(),
    round: 0,
    firstPlayerIndex: 0,
    currentTurnIndex: 0,
    deck: [],
    discard: [],
    draft: null,
    endAfterRound: false,
    players: [],
    recentActions: new Map()
  };
  const host = addPlayer(room, hostName);
  room.hostId = host.id;
  return { room, host };
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}

function addPlayer(room, name, options = {}) {
  if (room.status !== 'lobby') throw new Error('游戏已开始，不能加入。');
  if (room.players.length >= 3) throw new Error('房间已满。');
  const token = newId('tok_');
  const player = {
    id: newId('p_'),
    token,
    name: uniqueName(room, name || `玩家${room.players.length + 1}`),
    ready: Boolean(options.isBot),
    connected: Boolean(options.isBot),
    isBot: Boolean(options.isBot),
    cash: 15,
    hand: [],
    signed: [],
    lastDiscard: null,
    actionsUsed: freshActions()
  };
  room.players.push(player);
  return player;
}

function uniqueName(room, rawName) {
  const base = String(rawName || '玩家').trim().slice(0, 16) || '玩家';
  const existing = new Set(room.players.map((player) => player.name));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${base.slice(0, Math.max(1, 16 - String(suffix).length - 2))} (${suffix})`;
    if (!existing.has(next)) return next;
  }
  return `${base.slice(0, 8)} ${newId('').slice(0, 4)}`;
}

function freshActions() {
  return { sign: false, trade: false, poach: false };
}

function setReady(room, playerId, ready) {
  const player = mustPlayer(room, playerId);
  if (room.status !== 'lobby') throw new Error('游戏已开始。');
  player.ready = Boolean(ready);
}

function startGame(room, rng = randomInt) {
  if (room.status !== 'lobby') throw new Error('游戏已经开始。');
  if (room.players.length < 2) throw new Error('至少需要2名玩家。');
  if (!room.players.every((p) => p.ready)) throw new Error('所有玩家准备后才能开始。');
  room.status = 'playing';
  room.deck = shuffle(buildDeck(), rng);
  room.discard = [];
  room.round = 0;
  room.firstPlayerIndex = rng(room.players.length);
  room.currentTurnIndex = room.firstPlayerIndex;
  room.endAfterRound = false;
  room.players.forEach((player) => {
    player.cash = 15;
    player.hand = draw(room, 3);
    player.signed = [];
    player.lastDiscard = null;
    player.actionsUsed = freshActions();
  });
  beginRound(room, rng);
}

function ensureHost(room, playerId) {
  if (room.hostId !== playerId) throw new Error('只有房主可以执行该操作。');
}

function transferHostIfNeeded(room) {
  if (room.players.some((player) => player.id === room.hostId && player.connected)) return;
  const nextHost = room.players.find((player) => player.connected) || room.players[0];
  if (nextHost) room.hostId = nextHost.id;
}

function beginRound(room, rng = randomInt) {
  if (room.status !== 'playing') return;
  room.round += 1;
  room.players.forEach((p) => {
    p.actionsUsed = freshActions();
    p.lastDiscard = null;
  });
  const discards = [];
  for (let seat = 0; seat < room.players.length; seat += 1) {
    const player = room.players[seat];
    if (player.hand.length === 0) {
      discards.push({ playerId: player.id, seat, card: null, score: -1 });
      continue;
    }
    const index = rng(player.hand.length);
    const [card] = player.hand.splice(index, 1);
    room.discard.push(card);
    player.lastDiscard = card;
    discards.push({ playerId: player.id, seat, card, score: card.score });
  }

  const order = discards
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return seatDistance(room, a.seat) - seatDistance(room, b.seat);
    })
    .map((entry) => entry.playerId);

  const poolCount = room.players.length + 1;
  const pool = draw(room, poolCount).map((card) => ({
    slotId: newId('slot_'),
    card,
    revealedTo: null,
    takenBy: null
  }));
  if (pool.length < poolCount) room.endAfterRound = true;

  room.draft = {
    order,
    cursor: 0,
    pool,
    discards: discards.map((d) => ({
      playerId: d.playerId,
      score: d.card ? d.card.score : null,
      positionName: d.card ? d.card.positionName : null
    }))
  };
  if (pool.length === 0) finishDraft(room, rng);
}

function seatDistance(room, seat) {
  return (seat - room.firstPlayerIndex + room.players.length) % room.players.length;
}

function draw(room, count) {
  const cards = [];
  for (let i = 0; i < count && room.deck.length > 0; i += 1) {
    cards.push(room.deck.shift());
  }
  if (room.deck.length === 0) room.endAfterRound = true;
  return cards;
}

function revealDraft(room, playerId, slotId) {
  ensureDraftTurn(room, playerId);
  const slot = mustDraftSlot(room, slotId);
  if (slot.takenBy) throw new Error('这张选秀牌已经被拿走。');
  if (slot.revealedTo && slot.revealedTo !== playerId) throw new Error('这张牌已被其他玩家私下查看。');
  slot.revealedTo = playerId;
}

function chooseDraft(room, playerId, slotId, want, rng = randomInt) {
  ensureDraftTurn(room, playerId);
  const slot = mustDraftSlot(room, slotId);
  if (slot.takenBy) throw new Error('这张选秀牌已经被拿走。');
  if (!slot.revealedTo) slot.revealedTo = playerId;
  if (slot.revealedTo !== playerId) throw new Error('不能选择别人查看过的隐藏牌。');

  let chosen = slot;
  if (!want) {
    const alternatives = room.draft.pool.filter((s) => !s.takenBy && s.slotId !== slotId && !s.revealedTo);
    if (alternatives.length > 0) chosen = alternatives[rng(alternatives.length)];
  }
  chosen.takenBy = playerId;
  mustPlayer(room, playerId).hand.push(chosen.card);
  room.draft.cursor += 1;
  if (room.draft.cursor >= room.draft.order.length || remainingDraftSlots(room).length === 0) {
    finishDraft(room, rng);
  }
}

function remainingDraftSlots(room) {
  return room.draft ? room.draft.pool.filter((s) => !s.takenBy) : [];
}

function finishDraft(room, rng = randomInt) {
  if (!room.draft) return;
  remainingDraftSlots(room).forEach((slot) => {
    room.discard.push(slot.card);
    slot.takenBy = 'discard';
  });
  room.draft = null;
  room.currentTurnIndex = room.firstPlayerIndex;
  room.players.forEach((p) => {
    p.actionsUsed = freshActions();
  });
  if (room.players.length === 0) endGame(room);
}

function endTurn(room, playerId, rng = randomInt) {
  ensureTurn(room, playerId);
  if (room.status !== 'playing') throw new Error('游戏不在进行中。');
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  if (room.currentTurnIndex === room.firstPlayerIndex) {
    if (room.endAfterRound) {
      endGame(room);
      return;
    }
    room.firstPlayerIndex = (room.firstPlayerIndex + 1) % room.players.length;
    beginRound(room, rng);
  } else {
    currentPlayer(room).actionsUsed = freshActions();
  }
}

function signCard(room, playerId, cardId, salary) {
  ensureTurn(room, playerId);
  const player = mustPlayer(room, playerId);
  ensureActionAvailable(player, 'sign');
  salary = parseInt(salary, 10);
  if (!Number.isInteger(salary) || salary < 1) throw new Error('签约薪资至少为1。');
  if (player.cash < salary) throw new Error('钞票不足。');
  const handIndex = player.hand.findIndex((card) => card.id === cardId);
  if (handIndex < 0) throw new Error('不能签约不属于自己的手牌。');
  const card = player.hand[handIndex];
  if (player.signed.some((entry) => entry.card.position === card.position)) {
    throw new Error(`签约区已有${card.positionName}。`);
  }
  player.hand.splice(handIndex, 1);
  player.cash -= salary;
  player.signed.push({ card, salary });
  player.actionsUsed.sign = true;
  const [replacement] = draw(room, 1);
  if (replacement) player.hand.push(replacement);
}

function trade(room, playerId, targetId, offeredCardId, rng = randomInt) {
  ensureTurn(room, playerId);
  const player = mustPlayer(room, playerId);
  const target = mustPlayer(room, targetId);
  ensureActionAvailable(player, 'trade');
  if (player.id === target.id) throw new Error('不能和自己交易。');
  if (player.cash < 1) throw new Error('交易需要支付1个钞票。');
  if (target.hand.length === 0) throw new Error('交易对象没有手牌。');
  const ownIndex = player.hand.findIndex((card) => card.id === offeredCardId);
  if (ownIndex < 0) throw new Error('不能交易不属于自己的手牌。');
  const targetIndex = rng(target.hand.length);
  const [ownCard] = player.hand.splice(ownIndex, 1);
  const [targetCard] = target.hand.splice(targetIndex, 1);
  player.hand.push(targetCard);
  target.hand.push(ownCard);
  player.cash -= 1;
  target.cash += 1;
  player.actionsUsed.trade = true;
}

function poach(room, playerId, targetId, cardId, salary) {
  ensureTurn(room, playerId);
  const player = mustPlayer(room, playerId);
  const target = mustPlayer(room, targetId);
  ensureActionAvailable(player, 'poach');
  salary = parseInt(salary, 10);
  if (player.id === target.id) throw new Error('只能挖角其他玩家。');
  if (!Number.isInteger(salary) || salary < 1) throw new Error('新薪资无效。');
  const signedIndex = target.signed.findIndex((entry) => entry.card.id === cardId);
  if (signedIndex < 0) throw new Error('目标球员不在该玩家签约区。');
  const entry = target.signed[signedIndex];
  if (salary <= entry.salary) throw new Error('新薪资必须高于现有薪资。');
  if (player.cash < salary) throw new Error('钞票不足。');
  if (player.signed.some((own) => own.card.position === entry.card.position)) {
    throw new Error(`你的签约区已有${entry.card.positionName}。`);
  }
  target.signed.splice(signedIndex, 1);
  target.cash += entry.salary;
  player.cash -= salary;
  player.signed.push({ card: entry.card, salary });
  player.actionsUsed.poach = true;
}

function endGame(room) {
  room.status = 'ended';
  room.draft = null;
  room.results = room.players.map((player) => ({
    playerId: player.id,
    score: player.signed.reduce((sum, entry) => sum + entry.card.score, 0)
  }));
  const best = Math.max(...room.results.map((r) => r.score));
  room.results.forEach((r) => {
    r.winner = r.score === best;
  });
}

function restart(room) {
  if (room.status !== 'ended') throw new Error('游戏结束后才能重新开始。');
  room.status = 'lobby';
  room.round = 0;
  room.deck = [];
  room.discard = [];
  room.draft = null;
  room.results = null;
  room.endAfterRound = false;
  room.recentActions = new Map();
  room.players.forEach((player) => {
    player.ready = Boolean(player.isBot);
    player.cash = 15;
    player.hand = [];
    player.signed = [];
    player.lastDiscard = null;
    player.actionsUsed = freshActions();
  });
}

function ensureDraftTurn(room, playerId) {
  if (room.status !== 'playing' || !room.draft) throw new Error('当前不是选秀阶段。');
  if (room.draft.order[room.draft.cursor] !== playerId) throw new Error('还没轮到你选秀。');
}

function ensureTurn(room, playerId) {
  if (room.status !== 'playing' || room.draft) throw new Error('当前不能执行小回合操作。');
  if (!currentPlayer(room) || currentPlayer(room).id !== playerId) throw new Error('还没轮到你行动。');
}

function currentPlayer(room) {
  return room.players[room.currentTurnIndex];
}

function ensureActionAvailable(player, action) {
  if (!ACTIONS.includes(action)) throw new Error('未知操作。');
  if (player.actionsUsed[action]) throw new Error('该操作本小回合已经执行过。');
}

function mustPlayer(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw new Error('找不到玩家。');
  return player;
}

function mustDraftSlot(room, slotId) {
  const slot = room.draft && room.draft.pool.find((s) => s.slotId === slotId);
  if (!slot) throw new Error('找不到选秀牌。');
  return slot;
}

function publicCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    position: card.position,
    positionName: card.positionName,
    score: card.score,
    image: card.image
  };
}

function viewFor(room, viewerId = null) {
  const me = room.players.find((p) => p.id === viewerId);
  return {
    code: room.code,
    status: room.status,
    stateVersion: room.stateVersion || 1,
    hostId: room.hostId,
    isHost: room.hostId === viewerId,
    round: room.round,
    playerId: viewerId,
    phase: room.status === 'ended' ? 'ended' : room.draft ? 'draft' : room.status === 'playing' ? 'turn' : 'lobby',
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    currentPlayerId: room.draft ? room.draft.order[room.draft.cursor] : currentPlayer(room)?.id || null,
    firstPlayerId: room.players[room.firstPlayerIndex]?.id || null,
    endAfterRound: room.endAfterRound,
    players: room.players.map((player, index) => ({
      id: player.id,
      seat: index,
      name: player.name,
      isHost: player.id === room.hostId,
      isBot: player.isBot,
      ready: player.ready,
      connected: player.connected,
      cash: player.cash,
      handCount: player.hand.length,
      hand: player.id === viewerId ? player.hand.map(publicCard) : undefined,
      signed: player.signed.map((entry) => ({ card: publicCard(entry.card), salary: entry.salary })),
      lastDiscard:
        player.id === viewerId && player.lastDiscard
          ? publicCard(player.lastDiscard)
          : player.lastDiscard
            ? { score: player.lastDiscard.score, positionName: player.lastDiscard.positionName }
            : null,
      actionsUsed: player.id === viewerId ? player.actionsUsed : undefined
    })),
    draft: room.draft
      ? {
          order: room.draft.order,
          cursor: room.draft.cursor,
          discards: room.draft.discards,
          pool: room.draft.pool
            .filter((slot) => !slot.takenBy)
            .map((slot) => ({
              slotId: slot.slotId,
              revealedTo: slot.revealedTo,
              card: slot.revealedTo === viewerId ? publicCard(slot.card) : null
            }))
        }
      : null,
    me: me
      ? {
          id: me.id,
          name: me.name
        }
      : null,
    results: room.results || null
  };
}

module.exports = {
  POSITIONS,
  buildDeck,
  createRoom,
  addPlayer,
  ensureHost,
  transferHostIfNeeded,
  setReady,
  startGame,
  revealDraft,
  chooseDraft,
  signCard,
  trade,
  poach,
  endTurn,
  restart,
  viewFor,
  makeRoomCode,
  currentPlayer
};
