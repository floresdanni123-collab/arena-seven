import { CONN_STATE } from '../net/Protocol.js';

const TEAM_NAMES = ['BLUE', 'RED'];

/**
 * Online matchmaking screen: connect, find match (with elapsed timer + queue size), cancel, the
 * "opponent found" team reveal, countdown, disconnect / reconnect notices and the online result.
 */
export class MultiplayerMenu {
  constructor(root, { onFind, onCancel, onBack, onRematch, onNewMatch, onMenu, audio }) {
    this.audio = audio;
    this.el = document.createElement('div');
    this.el.className = 'screen panel-screen mp-screen hidden';
    this.el.innerHTML = `
      <div class="panel mp-panel">
        <h2>Online Match<small data-mp-sub>Play against another person over the internet</small></h2>
        <div class="mp-body">
          <div class="mp-status" data-mp-status>
            <div class="mp-conn" data-mp-conn><span class="dot"></span><span data-mp-conn-text>DISCONNECTED</span></div>
            <div class="mp-name" data-mp-name></div>
            <div class="mp-region"><span>REGION</span><strong>AUTO</strong></div>
          </div>
          <div class="mp-search hidden" data-mp-search>
            <div class="mp-searching"><span class="spinner"></span><span data-mp-search-text>FINDING OPPONENT...</span></div>
            <div class="mp-meta"><span>ELAPSED <strong data-mp-elapsed>00:00</strong></span><span>IN QUEUE <strong data-mp-waiting>1</strong></span></div>
          </div>
          <div class="mp-found hidden" data-mp-found>
            <div class="mp-found-title">OPPONENT FOUND</div>
            <div class="mp-vs">
              <div class="mp-team blue"><div class="tname">BLUE</div><div class="pname" data-mp-blue>-</div></div>
              <div class="mp-vs-mid">VS</div>
              <div class="mp-team red"><div class="tname">RED</div><div class="pname" data-mp-red>-</div></div>
            </div>
            <div class="mp-found-sub" data-mp-found-sub>STARTING MATCH...</div>
          </div>
          <div class="mp-error hidden" data-mp-error></div>
        </div>
        <div class="panel-actions">
          <button class="btn" data-action="back">Back</button>
          <button class="btn accent" data-action="find">Find Match</button>
          <button class="btn danger hidden" data-action="cancel">Cancel</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    const wire = (sel, fn) => { const b = this.q(sel); b.addEventListener('mouseenter', () => audio.play('hover', { volume: 0.5 })); b.addEventListener('click', () => { audio.play('click'); fn(); }); };
    wire('[data-action="find"]', onFind);
    wire('[data-action="cancel"]', onCancel);
    wire('[data-action="back"]', onBack);
    this.timer = null;

    // Countdown overlay (shown over the pitch once the match is loading)
    this.countdownEl = document.createElement('div');
    this.countdownEl.className = 'mp-countdown hidden';
    root.appendChild(this.countdownEl);

    // Opponent status overlay
    this.oppEl = document.createElement('div');
    this.oppEl.className = 'mp-opp hidden';
    root.appendChild(this.oppEl);

    // Online result screen
    this.resultEl = document.createElement('div');
    this.resultEl.className = 'screen pause-screen hidden';
    this.resultEl.innerHTML = `
      <div class="result-sub" data-r-sub>FULL TIME</div>
      <div class="pause-title" data-r-title>Draw</div>
      <div class="result-score"><span class="b" data-r-b>0</span><span>-</span><span class="r" data-r-r>0</span></div>
      <div class="result-sub" data-r-detail style="color: var(--muted); font-size: 16px;"></div>
      <div class="result-sub" data-r-rematch style="font-size: 16px;"></div>
      <nav class="pause-nav">
        <button class="menu-btn primary" style="--i:0" data-action="rematch"><span class="label">Rematch</span></button>
        <button class="menu-btn" style="--i:1" data-action="new"><span class="label">Find new match</span></button>
        <button class="menu-btn" style="--i:2" data-action="menu"><span class="label">Main menu</span></button>
      </nav>`;
    root.appendChild(this.resultEl);
    const rwire = (sel, fn) => { const b = this.resultEl.querySelector(sel); b.addEventListener('mouseenter', () => audio.play('hover', { volume: 0.5 })); b.addEventListener('click', () => { audio.play('click'); fn(); }); };
    rwire('[data-action="rematch"]', onRematch);
    rwire('[data-action="new"]', onNewMatch);
    rwire('[data-action="menu"]', onMenu);
  }

  show() { this.el.classList.remove('hidden'); this.hideError(); }
  hide() { this.el.classList.add('hidden'); this.stopTimer(); }

  setConnection(state, name = '') {
    const text = { [CONN_STATE.DISCONNECTED]: 'DISCONNECTED', [CONN_STATE.CONNECTING]: 'CONNECTING...', [CONN_STATE.CONNECTED]: 'CONNECTED', [CONN_STATE.SEARCHING]: 'SEARCHING', [CONN_STATE.MATCH_FOUND]: 'MATCH FOUND', [CONN_STATE.LOADING_MATCH]: 'LOADING MATCH', [CONN_STATE.IN_MATCH]: 'IN MATCH', [CONN_STATE.RECONNECTING]: 'RECONNECTING...', [CONN_STATE.MATCH_FINISHED]: 'MATCH FINISHED' }[state] || state;
    this.q('[data-mp-conn-text]').textContent = text;
    this.q('[data-mp-conn]').className = 'mp-conn ' + (state === CONN_STATE.DISCONNECTED ? 'off' : state === CONN_STATE.CONNECTING || state === CONN_STATE.RECONNECTING ? 'busy' : 'on');
    this.q('[data-mp-name]').textContent = name ? `YOU ARE ${name.toUpperCase()}` : '';
    const searching = state === CONN_STATE.SEARCHING;
    this.q('[data-mp-search]').classList.toggle('hidden', !searching);
    this.q('[data-action="find"]').classList.toggle('hidden', searching || state === CONN_STATE.MATCH_FOUND);
    this.q('[data-action="cancel"]').classList.toggle('hidden', !searching);
    this.q('[data-mp-found]').classList.toggle('hidden', state !== CONN_STATE.MATCH_FOUND);
    if (searching) this.startTimer(); else this.stopTimer();
  }

  startTimer() {
    if (this.timer) return;
    this.searchStart = Date.now();
    const tick = () => { const s = Math.floor((Date.now() - this.searchStart) / 1000); this.q('[data-mp-elapsed]').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    tick();
    this.timer = setInterval(tick, 500);
  }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  setQueue(msg) { this.q('[data-mp-waiting]').textContent = msg.waiting ?? 1; }

  showFound({ team, you, opponent }) {
    const blue = team === 0 ? you.name : opponent.name, red = team === 1 ? you.name : opponent.name;
    this.q('[data-mp-blue]').textContent = blue.toUpperCase() + (team === 0 ? ' (YOU)' : '');
    this.q('[data-mp-red]').textContent = red.toUpperCase() + (team === 1 ? ' (YOU)' : '');
    this.q('[data-mp-found-sub]').textContent = `YOU PLAY AS ${TEAM_NAMES[team]} · STARTING MATCH...`;
  }

  showError(text) { const e = this.q('[data-mp-error]'); e.textContent = text; e.classList.remove('hidden'); }
  hideError() { this.q('[data-mp-error]').classList.add('hidden'); }

  /** Big countdown over the pitch: 3, 2, 1, KICK OFF. */
  setCountdown(text) {
    if (!text) { this.countdownEl.classList.add('hidden'); return; }
    this.countdownEl.textContent = text;
    this.countdownEl.classList.remove('hidden');
    this.countdownEl.classList.remove('pop'); void this.countdownEl.offsetWidth; this.countdownEl.classList.add('pop');
  }

  setOpponentStatus(text) {
    if (!text) { this.oppEl.classList.add('hidden'); return; }
    this.oppEl.innerHTML = text;
    this.oppEl.classList.remove('hidden');
  }

  showResult({ score, winner, localTeam, shootout, reason, opponent }) {
    const [b, r] = score;
    const won = winner === localTeam, lost = winner !== null && winner !== undefined && winner !== localTeam;
    this.resultEl.querySelector('[data-r-b]').textContent = b;
    this.resultEl.querySelector('[data-r-r]').textContent = r;
    this.resultEl.querySelector('[data-r-title]').textContent = won ? 'You Win' : lost ? 'You Lose' : 'Draw';
    let sub = reason === 'OPPONENT_DISCONNECTED' ? 'MATCH ENDED · OPPONENT DISCONNECTED' : reason === 'CONNECTION_LOST' ? 'MATCH ENDED · CONNECTION LOST' : 'FULL TIME';
    if (shootout) sub += ` · PENALTIES ${shootout[0]}-${shootout[1]}`;
    this.resultEl.querySelector('[data-r-sub]').textContent = sub;
    this.resultEl.querySelector('[data-r-detail]').textContent = `BLUE ${b} - ${r} RED · VS ${(opponent || '').toUpperCase()}`;
    this.resultEl.querySelector('[data-r-rematch]').textContent = '';
    const rematchBtn = this.resultEl.querySelector('[data-action="rematch"]');
    rematchBtn.classList.toggle('hidden', reason === 'OPPONENT_DISCONNECTED' || reason === 'CONNECTION_LOST');
    this.resultEl.classList.remove('hidden');
  }
  setRematchText(text) { this.resultEl.querySelector('[data-r-rematch]').textContent = text; }
  hideResult() { this.resultEl.classList.add('hidden'); }
}
