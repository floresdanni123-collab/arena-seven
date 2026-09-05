import { TACKLE, JUKE, TEAM, TEAM_NAMES, RESTART } from '../utils/Constants.js';
import { MATCH_STATE } from '../match/MatchManager.js';

const ROLE_LABEL = { GK: 'GOALKEEPER', DEF: 'DEFENDER', MID: 'MIDFIELDER', ATT: 'ATTACKER' };
const RESTART_LABEL = { [RESTART.FREE_KICK]: 'FREE KICK', [RESTART.PENALTY]: 'PENALTY', [RESTART.THROW_IN]: 'THROW-IN', [RESTART.CORNER]: 'CORNER', [RESTART.GOAL_KICK]: 'GOAL KICK', [RESTART.KICKOFF]: 'KICK OFF' };

const OUTFIELD_HINTS = `
  <div><kbd>WASD</kbd> MOVE &nbsp; <kbd>SHIFT</kbd> SPRINT</div>
  <div><kbd>LMB</kbd> HARD KICK &nbsp; <kbd>RMB</kbd> HOLD: LOW KICK</div>
  <div><kbd>E</kbd> SLIDE TACKLE &nbsp; <kbd>Q</kbd> JUKE</div>
  <div><kbd>TAB</kbd> CYCLE PLAYER &nbsp; <kbd>SPACE</kbd> NEAREST &nbsp; <kbd>ESC</kbd> PAUSE</div>`;
const KEEPER_HINTS = `
  <div><kbd>WASD</kbd> MOVE &nbsp; <kbd>SHIFT</kbd> RUSH</div>
  <div><kbd>LMB</kbd> DIVE / KICK &nbsp; <kbd>RMB</kbd> CATCH / THROW (HOLD)</div>
  <div><kbd>E</kbd> SMOTHER &nbsp; <kbd>Q</kbd> SHUFFLE</div>
  <div><kbd>TAB</kbd> CYCLE PLAYER &nbsp; <kbd>ESC</kbd> PAUSE</div>`;
const SETPIECE_HINTS = {
  throwin: `<div><kbd>MOUSE</kbd> AIM</div><div><kbd>RMB</kbd> HOLD: THROW POWER &nbsp; <kbd>LMB</kbd> STRONG THROW</div>`,
  penalty: `<div><kbd>MOUSE</kbd> AIM</div><div><kbd>RMB</kbd> HOLD: PLACED SHOT &nbsp; <kbd>LMB</kbd> POWER SHOT</div>`,
  setpiece: `<div><kbd>MOUSE</kbd> AIM</div><div><kbd>RMB</kbd> HOLD: DRIVEN KICK &nbsp; <kbd>LMB</kbd> HARD KICK</div><div><kbd>TAB</kbd> CYCLE PLAYER</div>`
};

/**
 * In-match heads-up display: scoreboard + clock, ability cooldowns, kick power meter, player tag,
 * set-piece / card / shootout / replay panels, event banners and toasts.
 */
export class HUD {
  constructor(root, settings) {
    this.root = root;
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'hud hidden';
    this.el.innerHTML = `
      <div class="scoreboard">
        <div class="score-line">
          <div class="score-team blue"><span>BLUE</span><span class="num" data-score="0">0</span></div>
          <div class="score-mid">-</div>
          <div class="score-team red"><span class="num" data-score="1">0</span><span>RED</span></div>
        </div>
        <div class="match-clock" data-clock>05:00</div>
        <div class="possession-bar"><div data-poss></div></div>
      </div>
      <div class="player-tag"><div class="num" data-pnum>10</div><div><div class="name" data-pname>YOU</div><div class="role" data-prole>ATTACKER</div></div></div>
      <div class="crosshair"></div>
      <div class="power-meter" data-power>
        <div class="label" data-power-label>PASS</div>
        <div class="track"><div class="bar" data-power-bar></div></div>
        <div class="ticks"><i style="left:18%"></i><i style="left:45%"></i><i style="left:73%"></i></div>
      </div>
      <div class="abilities" data-abilities>
        <div class="ability" data-ability="tackle"><div class="fill"></div><div class="key">E</div><div class="name">TACKLE</div><div class="status">READY</div></div>
        <div class="ability" data-ability="juke"><div class="fill"></div><div class="key">Q</div><div class="name">JUKE</div><div class="status">READY</div></div>
      </div>
      <div class="controls-hint" data-controls></div>
      <div class="setpiece-banner" data-setpiece><div class="type" data-sp-type></div><div class="team" data-sp-team></div></div>
      <div class="card-popup" data-card><div class="card"></div><div class="who"><div class="cname" data-card-name></div><div class="creason" data-card-reason></div></div></div>
      <div class="shootout-panel" data-shootout>
        <div class="title">PENALTY SHOOTOUT</div>
        <div class="row blue"><span class="tname">BLUE</span><span class="marks" data-so-blue></span></div>
        <div class="row red"><span class="tname">RED</span><span class="marks" data-so-red></span></div>
        <div class="sub" data-so-sub></div>
      </div>
      <div class="replay-tag" data-replay><span class="rec"></span> REPLAY <span class="skip">SPACE SKIP</span></div>
      <div class="event-banner" data-banner></div>
      <div class="toast" data-toast></div>
      <div class="pointer-hint hidden" data-pointer>CLICK TO TAKE CONTROL</div>
    `;
    root.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    this.scoreEls = [this.q('[data-score="0"]'), this.q('[data-score="1"]')];
    this.clockEl = this.q('[data-clock]');
    this.possEl = this.q('[data-poss]');
    this.powerEl = this.q('[data-power]');
    this.powerBar = this.q('[data-power-bar]');
    this.powerLabel = this.q('[data-power-label]');
    this.abilities = { tackle: this.q('[data-ability="tackle"]'), juke: this.q('[data-ability="juke"]') };
    this.abilitiesEl = this.q('[data-abilities]');
    this.bannerEl = this.q('[data-banner]');
    this.toastEl = this.q('[data-toast]');
    this.pointerEl = this.q('[data-pointer]');
    this.controlsEl = this.q('[data-controls]');
    this.setPieceEl = this.q('[data-setpiece]');
    this.cardEl = this.q('[data-card]');
    this.shootoutEl = this.q('[data-shootout]');
    this.replayEl = this.q('[data-replay]');
    this.lastScore = [0, 0];
    this.wasReady = { tackle: true, juke: true };
    this.toastTimer = null;
    this.bannerTimer = null;
    this.setPieceTimer = null;
    this.cardTimer = null;
    this.lastPlayer = null;
    this.lastHints = '';
  }

  show() { this.el.classList.remove('hidden'); this.controlsEl.classList.toggle('hidden', !this.settings.get('showControls')); }
  hide() { this.el.classList.add('hidden'); }
  setPointerHint(v) { this.pointerEl.classList.toggle('hidden', !v); }

  update(match, audio) {
    const p = match.human;
    if (!p) return;
    for (let i = 0; i < 2; i++) {
      if (match.score[i] !== this.lastScore[i]) {
        this.scoreEls[i].textContent = match.score[i];
        this.scoreEls[i].classList.remove('bump'); void this.scoreEls[i].offsetWidth; this.scoreEls[i].classList.add('bump');
        this.lastScore[i] = match.score[i];
      }
    }
    this.clockEl.textContent = match.clockText;
    const remaining = match.duration - match.clock;
    this.clockEl.classList.toggle('urgent', isFinite(remaining) && remaining < 30 && match.state === MATCH_STATE.PLAYING);
    this.possEl.style.width = `${Math.round(match.possession.possessionShare() * 100)}%`;

    if (this.lastPlayer !== p) {
      this.q('[data-pnum]').textContent = p.number;
      this.q('[data-pname]').textContent = p.name.toUpperCase();
      this.q('[data-prole]').textContent = ROLE_LABEL[p.role] || p.role;
      this.lastPlayer = p;
    }

    // Control hints follow the active controller and set-piece mode
    const mode = p.isGoalkeeper ? match.gkController.mode : match.controller.mode;
    let hints = p.isGoalkeeper ? KEEPER_HINTS : OUTFIELD_HINTS;
    if (SETPIECE_HINTS[mode]) hints = SETPIECE_HINTS[mode];
    if (hints !== this.lastHints) { this.controlsEl.innerHTML = hints; this.lastHints = hints; }

    // Abilities only apply to outfield players
    this.abilitiesEl.classList.toggle('hidden', p.isGoalkeeper);
    if (!p.isGoalkeeper) {
      this.updateAbility('tackle', p.tackleCooldown, TACKLE.COOLDOWN, audio);
      this.updateAbility('juke', p.jukeCooldown, JUKE.COOLDOWN, audio);
    }

    if (p.charging) {
      const pw = p.chargePower;
      this.powerEl.classList.add('visible');
      this.powerBar.style.width = `${Math.round(pw * 100)}%`;
      if (mode === 'throwin' || (p.isGoalkeeper && p.hasBall)) this.powerLabel.textContent = pw < 0.25 ? 'ROLL' : pw < 0.6 ? 'THROW' : 'LONG THROW';
      else this.powerLabel.textContent = pw < 0.18 ? 'SOFT PASS' : pw < 0.45 ? 'PASS' : pw < 0.73 ? 'STRONG PASS' : pw < 0.99 ? 'DRIVEN SHOT' : 'MAX POWER';
    } else {
      this.powerEl.classList.remove('visible');
    }
  }

  updateAbility(name, cooldown, max, audio) {
    const el = this.abilities[name];
    const ready = cooldown <= 0;
    const status = el.querySelector('.status');
    const fill = el.querySelector('.fill');
    if (ready) {
      status.textContent = 'READY';
      fill.style.height = '100%';
      el.classList.remove('cooling');
      if (!this.wasReady[name]) {
        el.classList.remove('ready-flash'); void el.offsetWidth; el.classList.add('ready-flash');
        if (audio) audio.play('ready', { volume: 0.4 });
      }
    } else {
      status.textContent = `${cooldown.toFixed(1)}s`;
      fill.style.height = `${Math.round((1 - cooldown / max) * 100)}%`;
      el.classList.add('cooling');
    }
    this.wasReady[name] = ready;
  }

  showBanner(text, sub = '', cls = '', duration = 3000) {
    this.bannerEl.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    this.bannerEl.className = `event-banner show ${cls}`;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.bannerEl.classList.remove('show'), duration);
  }

  hideBanner() { clearTimeout(this.bannerTimer); this.bannerEl.classList.remove('show'); }

  toast(text, duration = 1400) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), duration);
  }

  /** Set-piece banner: "FREE KICK / BLUE BALL", "RED CORNER", etc. */
  showSetPiece(type, team, sub = '', duration = 3200) {
    const label = RESTART_LABEL[type] || type;
    const name = TEAM_NAMES[team];
    let teamText;
    if (type === RESTART.THROW_IN) teamText = `${name} THROW-IN`;
    else if (type === RESTART.CORNER) teamText = `${name} CORNER`;
    else teamText = `${name} ${type === RESTART.PENALTY ? '' : 'BALL'}`.trim();
    this.q('[data-sp-type]').textContent = label;
    this.q('[data-sp-team]').textContent = sub ? `${teamText} · ${sub}` : teamText;
    this.setPieceEl.className = `setpiece-banner show ${team === TEAM.BLUE ? 'blue' : 'red'}`;
    clearTimeout(this.setPieceTimer);
    if (duration > 0) this.setPieceTimer = setTimeout(() => this.setPieceEl.classList.remove('show'), duration);
  }

  hideSetPiece() { clearTimeout(this.setPieceTimer); this.setPieceEl.classList.remove('show'); }

  showCard(player, card, reason = '') {
    this.q('[data-card-name]').textContent = `${player.number} ${player.name.toUpperCase()}`;
    this.q('[data-card-reason]').textContent = reason;
    this.cardEl.className = `card-popup show ${card === 'RED' ? 'red' : 'yellow'}`;
    clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => this.cardEl.classList.remove('show'), 2800);
  }

  /** Shootout scoreboard: O scored, X missed, - pending. */
  setShootout(state) {
    if (!state) { this.shootoutEl.classList.remove('show'); return; }
    const marks = (arr, team) => {
      const slots = Math.max(state.rounds, arr.length + (state.suddenDeath ? 1 : 0));
      let html = '';
      for (let i = 0; i < slots; i++) {
        const v = arr[i];
        const cls = v === true ? 'hit' : v === false ? 'miss' : (state.currentTeam === team && i === arr.length && !state.finished ? 'next' : 'pending');
        html += `<i class="${cls}">${v === true ? 'O' : v === false ? 'X' : '-'}</i>`;
      }
      return html;
    };
    this.q('[data-so-blue]').innerHTML = marks(state.results[0], TEAM.BLUE);
    this.q('[data-so-red]').innerHTML = marks(state.results[1], TEAM.RED);
    this.q('[data-so-sub]').textContent = state.finished ? `${TEAM_NAMES[state.winner]} WIN` : state.suddenDeath ? 'SUDDEN DEATH' : `${TEAM_NAMES[state.currentTeam]} TO TAKE`;
    this.shootoutEl.classList.add('show');
  }

  setReplay(on) { this.replayEl.classList.toggle('show', !!on); }

  reset() {
    this.lastScore = [0, 0]; this.scoreEls[0].textContent = '0'; this.scoreEls[1].textContent = '0'; this.lastPlayer = null;
    this.hideSetPiece(); this.setShootout(null); this.setReplay(false); this.hideBanner();
    this.cardEl.classList.remove('show');
  }
}
