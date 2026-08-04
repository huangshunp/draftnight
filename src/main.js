import { io } from 'socket.io-client';
import './styles.css';

const STORAGE_KEY = 'basketball-card-game-session';
const app = document.querySelector('#app');

class GameClient {
  constructor(root, { persist = true, label = '' } = {}) {
    this.root = root;
    this.persist = persist;
    this.label = label;
    this.state = null;
    this.error = '';
    this.networkStatus = '正在连接';
    this.pending = new Set();
    this.session = persist ? readSession() : null;
    this.socket = io();
    this.bindSocket();
    this.render();
  }

  bindSocket() {
    this.socket.on('connect', () => {
      if (this.session) {
        this.networkStatus = '正在恢复房间';
        this.emit('resume', this.session).then((reply) => {
          this.networkStatus = reply?.ok ? '恢复成功' : '房间已经失效';
          if (!reply?.ok) {
            this.session = null;
            if (this.persist) localStorage.removeItem(STORAGE_KEY);
          }
          this.render();
        });
      } else {
        this.networkStatus = '已连接';
      }
      this.render();
    });
    this.socket.on('session', (session) => {
      this.session = session;
      if (this.persist) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    });
    this.socket.on('roomClosed', ({ reason } = {}) => {
      this.clearSession();
      this.error = reason || '房间已经取消。';
      this.networkStatus = this.socket.connected ? '已连接' : '连接断开';
      this.render();
    });
    this.socket.on('state', (state) => {
      if (this.state && state.stateVersion < this.state.stateVersion) return;
      this.state = state;
      this.error = '';
      this.render();
    });
    this.socket.on('errorMessage', (message) => {
      this.error = message;
      this.render();
    });
    this.socket.on('disconnect', () => {
      this.networkStatus = '连接断开';
      this.render();
    });
  }

  emit(event, payload = {}) {
    const actionKey = `${event}:${globalThis.crypto?.randomUUID?.() || Date.now()}:${Math.random()}`;
    const outgoing = mutatingEvent(event) ? { ...payload, actionId: payload.actionId || actionKey } : payload;
    this.pending.add(event);
    this.render();
    return new Promise((resolve) => {
      this.socket.emit(event, outgoing, (reply) => {
        this.pending.delete(event);
        if (reply && !reply.ok) {
          this.error = reply.error;
          this.render();
        } else if (reply?.left || reply?.closed) {
          this.clearSession();
        } else if (reply?.state && (!this.state || reply.state.stateVersion >= this.state.stateVersion)) {
          this.state = reply.state;
        }
        this.render();
        resolve(reply);
      });
    });
  }

  clearSession() {
    this.state = null;
    this.session = null;
    if (this.persist) localStorage.removeItem(STORAGE_KEY);
  }

  render() {
    this.root.innerHTML = `
      <section class="shell ${this.label ? 'compact' : ''}">
        <header class="topbar">
          <div>
            <h1>${this.label || '篮球球星卡桌游'}</h1>
            <p>${this.subtitle()}</p>
          </div>
          <div class="connection ${this.socket.connected ? 'on' : 'off'}">${escapeHtml(this.networkStatus)}</div>
        </header>
        ${this.error ? `<div class="notice danger">${escapeHtml(this.error)}</div>` : ''}
        ${this.state ? this.renderGame() : this.renderJoin()}
      </section>
    `;
    this.bindDom();
  }

  subtitle() {
    if (!this.state) return '公开网址进入 · 2-3 人房间 · 强制选秀';
    return `房间 ${this.state.code} · ${phaseName(this.state.phase)} · 第 ${this.state.round || 0} 大回合`;
  }

  renderJoin() {
    return `
      <div class="join-grid">
        <form data-action="create" class="panel">
          <h2>创建房间</h2>
          <input name="name" maxlength="16" placeholder="你的昵称" value="${this.label || ''}" />
          <button class="primary" type="submit" ${this.pending.has('createRoom') ? 'disabled' : ''}>创建</button>
        </form>
        <form data-action="join" class="panel">
          <h2>房间码加入</h2>
          <input name="name" maxlength="16" placeholder="你的昵称，不是房间名" value="${this.label || ''}" />
          <input name="code" maxlength="6" placeholder="输入房主给你的6位房间码" />
          <button type="submit" ${this.pending.has('joinRoom') ? 'disabled' : ''}>加入</button>
        </form>
      </div>
    `;
  }

  renderGame() {
    const me = playerMe(this.state);
    return `
      <div class="table-grid">
        <section class="panel room-panel">
          <div class="room-head">
            <h2>${this.state.code}</h2>
            <button data-copy="${this.state.code}" title="复制房间码">复制</button>
          </div>
          <p class="muted">把当前公开网址和这个 6 位房间码发给朋友。房间码不是密码。</p>
          <div class="stats">
            <span>牌库 ${this.state.deckCount}</span>
            <span>弃牌 ${this.state.discardCount}</span>
            <span>${this.state.endAfterRound ? '本轮后结算' : '继续游戏'}</span>
          </div>
          ${this.renderPlayers()}
        </section>
        <section class="panel main-panel">
          ${this.state.phase === 'lobby' ? this.renderLobby() : ''}
          ${this.state.phase === 'draft' ? this.renderDraft() : ''}
          ${this.state.phase === 'turn' ? this.renderTurn(me) : ''}
          ${this.state.phase === 'ended' ? this.renderResults() : ''}
        </section>
        <section class="panel hand-panel">
          <h2>我的手牌</h2>
          <div class="card-row">${(me?.hand || []).map((card) => renderCard(card, 'mini')).join('') || '<p class="muted">暂无手牌</p>'}</div>
        </section>
      </div>
    `;
  }

  renderPlayers() {
    return `
      <div class="players">
        ${this.state.players.map((player) => `
          <article class="player ${player.id === this.state.currentPlayerId ? 'active' : ''}">
            <div class="player-title">
              <strong>${escapeHtml(player.name)}</strong>
              <span>${player.isHost ? '房主' : player.connected ? '已连接' : '断线'}</span>
            </div>
            <div class="stats">
              <span>钞票 ${player.cash}</span>
              <span>手牌 ${player.handCount}</span>
              <span>${player.ready ? '已准备' : '未准备'}</span>
            </div>
            ${player.lastDiscard ? `<p class="muted">选秀弃牌：${player.lastDiscard.positionName || ''}${player.lastDiscard.score || ''}</p>` : ''}
            <div class="signed">${player.signed.map((entry) => `
              <div class="signed-card">
                ${renderCard(entry.card, 'tiny')}
                <span class="salary">$${entry.salary}</span>
              </div>
            `).join('') || '<span class="muted">签约区空</span>'}</div>
          </article>
        `).join('')}
      </div>
    `;
  }

  renderLobby() {
    const me = playerMe(this.state);
    return `
      <h2>房间大厅</h2>
      <p class="muted">2-3 名玩家均准备后开始。第三名之后会被服务器拒绝。</p>
      <div class="toolbar">
        <button data-ready="${!me?.ready}" ${this.pending.has('setReady') ? 'disabled' : ''}>${me?.ready ? '取消准备' : '准备'}</button>
        ${this.state.isHost ? `<button class="primary" data-start ${this.pending.has('startGame') ? 'disabled' : ''}>开始游戏</button>` : ''}
        <button data-leave-room ${this.pending.has('leaveRoom') ? 'disabled' : ''}>${this.state.isHost ? '取消房间' : '离开房间'}</button>
      </div>
    `;
  }

  renderDraft() {
    const isMine = this.state.currentPlayerId === this.state.playerId;
    return `
      <h2>强制选秀</h2>
      <p class="muted">顺序：${this.state.draft.order.map((id) => escapeHtml(nameById(this.state, id))).join(' → ')}</p>
      <div class="draft-grid">
        ${this.state.draft.pool.map((slot) => `
          <article class="draft-slot">
            ${slot.card ? renderCard(slot.card) : `<img class="card" src="/background/背面.png" alt="隐藏牌" />`}
            ${isMine ? `
              <div class="toolbar">
                ${slot.card ? `
                  <button class="primary" data-choose="${slot.slotId}" data-want="true" ${this.pending.has('chooseDraft') ? 'disabled' : ''}>要</button>
                  <button data-choose="${slot.slotId}" data-want="false" ${this.pending.has('chooseDraft') ? 'disabled' : ''}>不要</button>
                ` : `<button data-reveal="${slot.slotId}" ${this.pending.has('revealDraft') ? 'disabled' : ''}>翻看</button>`}
              </div>
            ` : `<p class="muted">${slot.revealedTo ? '有人查看中' : '未翻开'}</p>`}
          </article>
        `).join('')}
      </div>
      ${!isMine ? `<div class="notice">等待 ${escapeHtml(nameById(this.state, this.state.currentPlayerId))} 选牌</div>` : ''}
    `;
  }

  renderTurn(me) {
    const isMine = this.state.currentPlayerId === this.state.playerId;
    if (!isMine) return `<h2>玩家小回合</h2><div class="notice">等待 ${escapeHtml(nameById(this.state, this.state.currentPlayerId))} 行动</div>`;
    return `
      <h2>我的小回合</h2>
      <div class="action-grid">
        ${this.renderSign(me)}
        ${this.renderTrade(me)}
        ${this.renderPoach(me)}
      </div>
      <div class="toolbar endbar">
        <button class="primary" data-end-turn ${this.pending.has('endTurn') ? 'disabled' : ''}>结束小回合</button>
        <button data-leave-room ${this.pending.has('leaveRoom') ? 'disabled' : ''}>退出房间</button>
      </div>
    `;
  }

  renderSign(me) {
    const used = me?.actionsUsed?.sign;
    return `
      <form class="action-card" data-action="sign">
        <h3>签约 ${used ? '<span>已用</span>' : ''}</h3>
        <select name="cardId" ${used ? 'disabled' : ''}>
          ${(me?.hand || []).map((card) => `<option value="${card.id}">${card.positionName}${card.score}</option>`).join('')}
        </select>
        <input name="salary" type="number" min="1" value="1" ${used ? 'disabled' : ''} />
        <button ${used || this.pending.has('sign') ? 'disabled' : ''}>签约</button>
      </form>
    `;
  }

  renderTrade(me) {
    const used = me?.actionsUsed?.trade;
    const targets = this.state.players.filter((p) => p.id !== this.state.playerId);
    return `
      <form class="action-card" data-action="trade">
        <h3>交易 ${used ? '<span>已用</span>' : ''}</h3>
        <select name="targetId" ${used ? 'disabled' : ''}>${targets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
        <select name="offeredCardId" ${used ? 'disabled' : ''}>${(me?.hand || []).map((card) => `<option value="${card.id}">${card.positionName}${card.score}</option>`).join('')}</select>
        <button ${used || this.pending.has('trade') ? 'disabled' : ''}>支付 1 钞票交易</button>
      </form>
    `;
  }

  renderPoach(me) {
    const used = me?.actionsUsed?.poach;
    const targets = this.state.players
      .filter((p) => p.id !== this.state.playerId)
      .flatMap((p) => p.signed.map((entry) => ({ player: p, entry })));
    return `
      <form class="action-card" data-action="poach">
        <h3>挖角 ${used ? '<span>已用</span>' : ''}</h3>
        <select name="target" ${used ? 'disabled' : ''}>
          ${targets.map(({ player, entry }) => `<option value="${player.id}|${entry.card.id}">${escapeHtml(player.name)} · ${entry.card.positionName}${entry.card.score} · $${entry.salary}</option>`).join('')}
        </select>
        <input name="salary" type="number" min="1" value="2" ${used ? 'disabled' : ''} />
        <button ${used || this.pending.has('poach') ? 'disabled' : ''}>挖角</button>
      </form>
    `;
  }

  renderResults() {
    const rows = this.state.results.map((result) => {
      const player = this.state.players.find((p) => p.id === result.playerId);
      return `<tr><td>${escapeHtml(player?.name || '')}</td><td>${result.score}</td><td>${result.winner ? '胜利' : ''}</td></tr>`;
    }).join('');
    return `
      <h2>游戏结算</h2>
      <table><thead><tr><th>玩家</th><th>签约分数</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>
      ${this.state.isHost ? `<button data-restart ${this.pending.has('restart') ? 'disabled' : ''}>重新开始</button>` : ''}
      <button data-leave-room ${this.pending.has('leaveRoom') ? 'disabled' : ''}>${this.state.isHost ? '关闭房间' : '离开房间'}</button>
    `;
  }

  bindDom() {
    this.root.querySelector('[data-action="create"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.emit('createRoom', formData(event.currentTarget));
    });
    this.root.querySelector('[data-action="join"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.emit('joinRoom', formData(event.currentTarget));
    });
    this.root.querySelector('[data-ready]')?.addEventListener('click', (event) => {
      this.emit('setReady', { ready: event.currentTarget.dataset.ready === 'true' });
    });
    this.root.querySelector('[data-start]')?.addEventListener('click', () => this.emit('startGame'));
    this.root.querySelector('[data-end-turn]')?.addEventListener('click', () => this.emit('endTurn'));
    this.root.querySelector('[data-restart]')?.addEventListener('click', () => this.emit('restart'));
    this.root.querySelector('[data-leave-room]')?.addEventListener('click', () => this.emit('leaveRoom'));
    this.root.querySelectorAll('[data-reveal]').forEach((button) => {
      button.addEventListener('click', () => this.emit('revealDraft', { slotId: button.dataset.reveal }));
    });
    this.root.querySelectorAll('[data-choose]').forEach((button) => {
      button.addEventListener('click', () => this.emit('chooseDraft', { slotId: button.dataset.choose, want: button.dataset.want === 'true' }));
    });
    this.root.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      await navigator.clipboard?.writeText(event.currentTarget.dataset.copy);
    });
    this.root.querySelector('[data-action="sign"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.emit('sign', formData(event.currentTarget));
    });
    this.root.querySelector('[data-action="trade"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.emit('trade', formData(event.currentTarget));
    });
    this.root.querySelector('[data-action="poach"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = formData(event.currentTarget);
      const [targetId, cardId] = String(data.target || '').split('|');
      this.emit('poach', { targetId, cardId, salary: data.salary });
    });
  }
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function playerMe(state) {
  return state.players.find((player) => player.id === state.playerId);
}

function nameById(state, id) {
  return state.players.find((player) => player.id === id)?.name || '未知玩家';
}

function phaseName(phase) {
  return { lobby: '大厅', draft: '选秀', turn: '小回合', ended: '结算' }[phase] || phase;
}

function mutatingEvent(event) {
  return ['setReady', 'startGame', 'revealDraft', 'chooseDraft', 'sign', 'trade', 'poach', 'endTurn', 'restart', 'leaveRoom'].includes(event);
}

function renderCard(card, size = '') {
  return `
    <figure class="card-wrap ${size}">
      <img class="card" src="${card.image}" alt="${card.positionName}${card.score}" />
      <figcaption>${card.positionName}${card.score}</figcaption>
    </figure>
  `;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

new GameClient(app);
