import * as THREE from 'three';
import { Settings } from './Settings.js';
import { SceneManager } from './SceneManager.js';
import { InputManager } from './InputManager.js';
import { AudioManager } from './AudioManager.js';
import { AssetLoader } from './AssetLoader.js';
import { EventBus } from './EventBus.js';
import { Pitch } from '../world/Pitch.js';
import { Goal } from '../world/Goal.js';
import { Stadium } from '../world/Stadium.js';
import { CinematicCamera } from '../camera/CinematicCamera.js';
import { MatchManager, MATCH_STATE } from '../match/MatchManager.js';
import { PlayerModel } from '../player/PlayerModel.js';
import { PlayerAnimationController } from '../player/PlayerAnimationController.js';
import { MainMenu } from '../ui/MainMenu.js';
import { HUD } from '../ui/HUD.js';
import { PauseMenu, ResultScreen } from '../ui/PauseMenu.js';
import { SettingsMenu } from '../ui/SettingsMenu.js';
import { LockerMenu } from '../ui/LockerMenu.js';
import { StatsMenu } from '../ui/StatsMenu.js';
import { DebugRenderer } from '../debug/DebugRenderer.js';
import { NetworkClient } from '../net/NetworkClient.js';
import { OnlineMatch } from '../net/OnlineMatch.js';
import { MultiplayerMenu } from '../ui/MultiplayerMenu.js';
import { CONN_STATE } from '../net/Protocol.js';
import { TouchControls } from '../ui/TouchControls.js';
import { DeviceInfo } from './DeviceInfo.js';
import { TEAM, TEAM_NAMES, COLORS } from '../utils/Constants.js';
import { rand } from '../utils/MathUtils.js';

export const GAME_STATE = { LOADING: 'LOADING', MENU: 'MENU', MATCH: 'MATCH', PAUSED: 'PAUSED', RESULT: 'RESULT' };

/**
 * Top-level application: owns the renderer, the persistent arena (pitch/goals/stadium), the menu
 * cinematic and the current match. Drives the frame loop and high-level state transitions.
 */
export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = new Settings();
    // First launch: pick a graphics preset that suits the device (touch-first devices start lower).
    if (!this.settings.get('qualityAutoSet')) {
      const q = DeviceInfo.suggestedQuality;
      this.settings.set('graphicsQuality', q);
      this.settings.set('shadowQuality', q === 'LOW' ? 'LOW' : q === 'MEDIUM' ? 'MEDIUM' : 'MEDIUM');
      this.settings.set('qualityAutoSet', true);
    }
    this.sceneManager = new SceneManager(canvas, this.settings);
    this.scene = this.sceneManager.scene;
    this.input = new InputManager(canvas);
    if (DeviceInfo.touchFirst) this.input.setMode('touch');
    this.audio = new AudioManager(this.settings);
    this.fps = { frames: 0, time: 0, avg: 60, lowSince: 0, suggested: false };
    this.assets = new AssetLoader();
    this.events = new EventBus();
    this.uiRoot = document.getElementById('ui-root');
    this.state = GAME_STATE.LOADING;
    this.match = null;
    this.clock = new THREE.Clock();
    this.debugEnabled = false;
    this.lastMenuState = null;

    this.buildLoadingScreen();
    this.input.onEscape = () => this.onEscape();
    this.input.onPointerLockChange = (locked) => this.onPointerLockChange(locked);
    window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.toggleDebug(); } });
  }

  /* ------------------------------------------------------------ boot */

  buildLoadingScreen() {
    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'screen loading-screen';
    this.loadingEl.innerHTML = `<div class="title">Arena Seven</div><div class="bar"><div data-bar></div></div><div class="sub" data-sub>Loading assets</div>`;
    this.uiRoot.appendChild(this.loadingEl);
  }

  async start() {
    const bar = this.loadingEl.querySelector('[data-bar]');
    this.assets.onProgress = (p) => { bar.style.width = `${Math.round(p * 100)}%`; };
    await this.assets.loadAll();
    bar.style.width = '100%';
    this.loadingEl.querySelector('[data-sub]').textContent = this.assets.hasPlayerModel() ? 'GLB characters loaded' : 'Using built-in characters';

    this.buildArena();
    this.buildUI();
    this.debug = new DebugRenderer(this.scene, this.uiRoot);
    this.cinematic = new CinematicCamera(this.sceneManager.camera);
    this.buildShowcase();

    setTimeout(() => {
      this.loadingEl.remove();
      this.enterMenu();
      // A refresh mid-match: the stored reconnect token puts us straight back into the room.
      if (this.net.loadStoredSession()) this.net.connect({ reconnect: true });
    }, 350);
    this.loop();
  }

  buildArena() {
    this.pitch = new Pitch(this.assets);
    this.goals = [new Goal(-1), new Goal(1)];
    const q = this.settings.get('graphicsQuality');
    this.stadium = new Stadium({ crowdDensity: q === 'LOW' ? 0.5 : q === 'MEDIUM' ? 0.8 : 1 });
    this.scene.add(this.pitch.group, this.goals[0].group, this.goals[1].group, this.stadium.group);
    this.arena = { pitch: this.pitch, goals: this.goals, stadium: this.stadium };
  }

  buildUI() {
    const audio = this.audio;
    this.mainMenu = new MainMenu(this.uiRoot, {
      audio,
      onPlay: () => this.startMatch('match'),
      onMultiplayer: () => this.openMultiplayer(),
      onTraining: () => this.startMatch('training'),
      onLocker: () => this.openPanel(this.lockerMenu),
      onStats: () => this.openPanel(this.statsMenu),
      onSettings: () => this.openPanel(this.settingsMenu)
    });
    this.settingsMenu = new SettingsMenu(this.uiRoot, this.settings, { audio, onClose: () => this.closePanel() });
    this.lockerMenu = new LockerMenu(this.uiRoot, this.settings, { audio, onClose: () => this.closePanel(), onChange: (p) => this.updateShowcase(p) });
    this.statsMenu = new StatsMenu(this.uiRoot, this.settings, { audio, onClose: () => this.closePanel() });
    this.hud = new HUD(this.uiRoot, this.settings);
    this.pauseMenu = new PauseMenu(this.uiRoot, {
      audio,
      onResume: () => this.resumeMatch(),
      onSettings: () => this.openPanel(this.settingsMenu),
      onQuit: () => this.quitToMenu()
    });
    this.resultScreen = new ResultScreen(this.uiRoot, { audio, onRematch: () => this.startMatch(this.match ? this.match.mode : 'match'), onMenu: () => this.quitToMenu() });
    this.activePanel = null;
    this.buildMultiplayer();

    // Touch layer: feeds the same actions as keyboard/mouse; visible only in touch mode during a match.
    this.touch = new TouchControls(this.uiRoot, this.input, this.settings, {
      onPause: () => { if (this.state === GAME_STATE.MATCH) this.pauseMatch(); },
      onSkip: () => { if (this.match && this.match.replays.isPlaying) this.match.replays.skip(); }
    });
    this.input.onModeChange((mode) => this.applyInputMode(mode));
    this.applyInputMode(this.input.mode);
    // Light haptics for the big moments (optional, ignored where unsupported).
    const buzz = (ms) => this.touch.vibrate(ms);
    this.events.on('goal_scored', () => buzz(40));
    this.events.on('tackle_hit', ({ player, victim }) => { if (this.match && (player === this.match.human || victim === this.match.human)) buzz(25); });
    this.events.on('kick', ({ player }) => { if (this.match && player === this.match.human) buzz(10); });

    // Gameplay event -> HUD feedback
    const teamCls = (team) => (team === TEAM.BLUE ? 'blue' : 'red');
    this.events.on('goal_scored', ({ team }) => {
      this.hud.showBanner('GOAL!', '', teamCls(team), 1200);
    });
    this.events.on('goal_ui', ({ team, scorer, ownGoal, score }) => {
      const who = scorer ? scorer.name.toUpperCase() : '';
      this.hud.showBanner('GOAL!', `${ownGoal ? 'OWN GOAL' : who} · ${TEAM_NAMES[team]} · ${score[0]}-${score[1]}`, teamCls(team), 2100);
    });
    this.events.on('juke_success', ({ player }) => { if (player.isHuman) this.hud.toast('JUKED!'); });
    this.events.on('tackle_hit', ({ player, victim, foul }) => {
      if (foul) return;
      if (player.isHuman) this.hud.toast('TACKLE WON'); else if (victim.isHuman) this.hud.toast('TACKLED');
    });
    this.events.on('save', ({ type }) => { this.hud.toast(type === 'catch' ? 'SAVE!' : type === 'block' ? 'BLOCKED!' : 'PARRIED!'); this.audio.play('crowd_ooh', { volume: 0.5 }); });
    this.events.on('post', ({ name }) => this.hud.toast(name === 'CROSSBAR' ? 'OFF THE CROSSBAR!' : 'OFF THE POST!'));
    this.events.on('kickoff', () => { if (this.match && this.match.training) this.hud.toast('TRAINING · R RESETS THE BALL', 2500); });
    this.events.on('player_switch', ({ player, reason }) => { if (reason !== 'pass') this.hud.toast(`NOW CONTROLLING ${player.name.toUpperCase()}${player.isGoalkeeper ? ' (GK)' : ''}`, 1200); });
    this.events.on('fulltime', (d) => this.onFullTime(d));
    this.events.on('fulltime_tied', () => this.hud.showBanner('FULL TIME', 'DRAW · PENALTY SHOOTOUT', '', 2400));
    // Rules & restarts
    this.events.on('foul_awarded', ({ type, team, verdict }) => {
      const reason = verdict && verdict.reason ? verdict.reason.replace(/_/g, ' ') : '';
      this.hud.showSetPiece(type, team, `FOUL · ${reason}`, 3600);
      this.hud.showBanner(type === 'PENALTY' ? 'PENALTY!' : 'FOUL', '', teamCls(team), 1300);
    });
    this.events.on('advantage', () => this.hud.toast('ADVANTAGE · PLAY ON', 1600));
    this.events.on('card', ({ player, card, secondYellow, verdict }) => {
      this.hud.showCard(player, card, secondYellow ? 'SECOND YELLOW' : (verdict && verdict.reason ? verdict.reason.replace(/_/g, ' ') : ''));
      this.audio.play('whistle', { volume: 0.6 });
    });
    this.events.on('send_off', ({ player }) => this.hud.toast(`${player.name.toUpperCase()} SENT OFF · ${TEAM_NAMES[player.team]} DOWN TO ${this.match ? this.match.players.filter((p) => p.team === player.team).length : 6}`, 2600));
    this.events.on('ball_out', (d) => { if (!this.match || !this.match.replays.isPlaying) this.hud.showSetPiece(d.type, d.team, '', 3000); });
    this.events.on('set_piece', ({ type, team, shootout }) => { if (!shootout) this.hud.showSetPiece(type, team, '', 3000); });
    this.events.on('replay_start', () => this.hud.setReplay(true));
    this.events.on('replay_end', () => this.hud.setReplay(false));
    this.events.on('shootout_start', () => this.hud.showBanner('PENALTIES', 'FIVE EACH · SUDDEN DEATH IF LEVEL', '', 2600));
    this.events.on('shootout_update', (s) => this.hud.setShootout(s));
    this.events.on('shootout_kick', ({ team, scored }) => this.hud.showBanner(scored ? 'GOAL!' : 'MISSED!', TEAM_NAMES[team], teamCls(team), 1400));
    this.events.on('toast', ({ text }) => this.hud.toast(text));
    // Shift lock: remembered for the rest of the session so new matches keep the player's choice.
    this.events.on('shift_lock', ({ enabled }) => { this.shiftLockSession = enabled; this.hud.setShiftLock(enabled, true); });
  }

  /** Switch HUD/controls presentation between desktop and touch (auto-detected from the last input device). */
  applyInputMode(mode) {
    const touch = mode === 'touch';
    this.hud.setTouchMode(touch);
    this.touch.setVisible(touch && this.state === GAME_STATE.MATCH);
    if (touch) {
      this.input.wantsPointerLock = false;
      this.input.exitPointerLock();
      document.body.style.cursor = 'default';
      this.hud.setPointerHint(false);
    } else if (this.state === GAME_STATE.MATCH) {
      this.input.wantsPointerLock = true;
      this.hud.setPointerHint(!this.input.pointerLocked);
      document.body.style.cursor = 'none';
    }
  }

  /* ------------------------------------------------------------ menu showcase */

  buildShowcase() {
    const p = this.settings.profile;
    this.showcase = new PlayerModel({ assets: this.assets, shirtColor: p.shirtColor, shortsColor: p.shortsColor, socksColor: p.shirtColor, skinTone: p.skinTone, hairColor: p.hairColor, hairStyle: p.hairStyle, number: p.shirtNumber, name: p.playerName });
    this.showcase.root.position.copy(this.cinematic.focus).setY(0);
    this.showcase.root.rotation.y = Math.PI * 0.85;
    this.scene.add(this.showcase.root);
    this.showcaseAnim = new PlayerAnimationController(this.showcase);
    this.showcaseAnim.setLocomotion({ speed: 0, sprinting: false, hasBall: false, isKeeper: false });
    this.showcaseTimer = 4;
    // A ball at the showcase player's feet
    this.showcaseBall = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 16), new THREE.MeshStandardMaterial({ map: (this.assets.getTexture('ballAlbedo') || null), color: this.assets.getTexture('ballAlbedo') ? 0xffffff : 0xf2f2f2, roughness: 0.5 }));
    this.showcaseBall.castShadow = true;
    this.showcaseBall.position.copy(this.showcase.root.position).add(new THREE.Vector3(0.35, 0.15, 0.55));
    this.scene.add(this.showcaseBall);
  }

  updateShowcase(profile) {
    this.showcase.setColors({ shirt: profile.shirtColor, shorts: profile.shortsColor, socks: profile.shirtColor, skin: profile.skinTone, hair: profile.hairColor });
    this.showcase.setHairStyle(profile.hairStyle);
    this.showcase.setNumber(profile.shirtNumber);
    this.showcase.setName(profile.playerName);
  }

  /* ------------------------------------------------------------ state transitions */

  enterMenu() {
    this.state = GAME_STATE.MENU;
    this.showcase.root.visible = true;
    this.showcaseBall.visible = true;
    this.mainMenu.show();
    this.hud.hide();
    this.hud.setPointerHint(false);
    if (this.touch) this.touch.setVisible(false);
    this.input.wantsPointerLock = false;
    this.input.exitPointerLock();
    this.audio.startMusic();
    document.body.style.cursor = 'default';
  }

  openPanel(panel) {
    if (this.activePanel) this.activePanel.hide();
    this.activePanel = panel;
    panel.show();
  }

  closePanel() {
    if (this.activePanel) this.activePanel.hide();
    this.activePanel = null;
  }

  startMatch(mode) {
    this.closePanel();
    this.mainMenu.hide();
    this.resultScreen.hide();
    this.pauseMenu.hide();
    if (this.match) { this.match.dispose(); this.match = null; }
    this.showcase.root.visible = false;
    this.showcaseBall.visible = false;
    this.audio.stopMusic();
    this.hud.reset();
    const initialShiftLock = this.shiftLockSession ?? !!this.settings.get('shiftLockDefault');
    this.match = new MatchManager({ sceneManager: this.sceneManager, assets: this.assets, settings: this.settings, audio: this.audio, events: this.events, input: this.input, arena: this.arena, mode, initialShiftLock }).start();
    this.hud.setShiftLock(initialShiftLock);
    this.state = GAME_STATE.MATCH;
    this.hud.show();
    this.enterMatchInput();
    this.hud.showBanner(mode === 'training' ? 'TRAINING' : 'KICK OFF', mode === 'training' ? 'FREE PRACTICE' : `BLUE vs RED · ${Math.round(this.match.duration / 60)} MIN`, '', 2200);
  }

  /** Pointer lock for mouse play, touch layer (and first-time tutorial) for touch play. */
  enterMatchInput() {
    if (this.input.mode === 'touch') {
      this.input.wantsPointerLock = false;
      this.touch.setVisible(true);
      this.hud.setPointerHint(false);
      document.body.style.cursor = 'default';
      if (!this.settings.get('touchTutorialSeen')) this.touch.showTutorial(() => this.settings.set('touchTutorialSeen', true));
    } else {
      this.input.wantsPointerLock = true;
      this.input.requestPointerLock();
      this.hud.setPointerHint(!this.input.pointerLocked);
      document.body.style.cursor = 'none';
    }
  }

  pauseMatch() {
    if (this.state !== GAME_STATE.MATCH) return;
    this.state = GAME_STATE.PAUSED;
    this.match.paused = !this.match.online; // an online match keeps running on the server
    this.input.wantsPointerLock = false;
    this.input.exitPointerLock();
    this.touch.setVisible(false);
    this.pauseMenu.show();
    this.hud.setPointerHint(false);
    document.body.style.cursor = 'default';
  }

  resumeMatch() {
    if (this.state !== GAME_STATE.PAUSED) return;
    this.closePanel();
    this.pauseMenu.hide();
    this.state = GAME_STATE.MATCH;
    this.match.paused = false;
    this.input.clearAll();
    if (this.input.mode === 'touch') {
      this.touch.setVisible(true);
      document.body.style.cursor = 'default';
    } else {
      this.input.wantsPointerLock = true;
      this.input.requestPointerLock(); // called from the click handler so the gesture is valid
      document.body.style.cursor = 'none';
    }
  }

  quitToMenu() {
    if (this.match && this.match.online) this.leaveOnline();
    if (this.match) { this.match.dispose(); this.match = null; }
    this.closePanel();
    this.pauseMenu.hide();
    this.resultScreen.hide();
    if (this.mpMenu) { this.mpMenu.hideResult(); this.mpMenu.setCountdown(null); this.mpMenu.setOpponentStatus(null); }
    this.enterMenu();
  }

  /* ------------------------------------------------------------ online multiplayer */

  buildMultiplayer() {
    this.net = new NetworkClient(NetworkClient.defaultUrl());
    this.mpMenu = new MultiplayerMenu(this.uiRoot, {
      audio: this.audio,
      onFind: () => this.findMatch(),
      onCancel: () => { this.net.cancelMatch(); },
      onBack: () => { this.net.cancelMatch(); this.closePanel(); },
      onRematch: () => { this.net.rematch(true); this.mpMenu.setRematchText('REMATCH REQUESTED · WAITING FOR OPPONENT'); },
      onNewMatch: () => { this.leaveOnline(); if (this.match) { this.match.dispose(); this.match = null; } this.mpMenu.hideResult(); this.enterMenu(); this.openMultiplayer(); this.findMatch(); },
      onMenu: () => this.quitToMenu()
    });
    const net = this.net;
    net.events.on('state', ({ state }) => {
      this.mpMenu.setConnection(state, net.identity ? net.identity.displayName : '');
      if (state === CONN_STATE.RECONNECTING && this.match && this.match.online) this.mpMenu.setOpponentStatus('CONNECTION LOST<br><small>RECONNECTING...</small>');
    });
    net.events.on('welcome', (w) => {
      this.mpMenu.setConnection(net.state, w.displayName);
      if (this.match && this.match.online && w.resumed) this.mpMenu.setOpponentStatus('RECONNECTED<br><small>RESUMING MATCH</small>');
      // Reconnected, but the server no longer knows our match (restart / grace expired): end it here.
      if (this.match && this.match.online && !w.resumed && this.state !== GAME_STATE.RESULT) {
        this.onOnlineMatchEnd({ reason: 'CONNECTION_LOST', winner: null, score: [...this.match.score], shootout: null });
      }
    });
    net.events.on('queue', (q) => this.mpMenu.setQueue(q));
    net.events.on('match_found', (m) => this.onMatchFound(m));
    net.events.on('start_match', (m) => this.onStartOnline(m));
    net.events.on('opponent', (o) => this.onOpponentStatus(o));
    net.events.on('match_end', (e) => this.onOnlineMatchEnd(e));
    net.events.on('rematch', (r) => this.onRematchMessage(r));
    net.events.on('error', (e) => { if (e.code === 'RECONNECT_FAILED' && this.match && this.match.online) { this.mpMenu.setOpponentStatus(null); this.quitToMenu(); this.openMultiplayer(); this.mpMenu.showError('Connection to the server was lost.'); } else if (this.state === GAME_STATE.MENU) this.mpMenu.showError(e.message || e.code); });
    net.events.on('disconnected', ({ wasInMatch }) => { if (!wasInMatch && this.state === GAME_STATE.MENU) this.mpMenu.setConnection(CONN_STATE.DISCONNECTED); });
    // Browsers throttle timers in hidden tabs; let incoming snapshots drive the replica so it never stalls.
    net.events.on('snapshot', () => { if (document.hidden && this.match && this.match.online && performance.now() - this.lastFrameAt > 45) this.frame(false); });
  }

  openMultiplayer() {
    this.openPanel(this.mpMenu);
    this.mpMenu.setConnection(this.net.state, this.net.identity ? this.net.identity.displayName : '');
    if (this.net.state === CONN_STATE.DISCONNECTED) this.net.connect({ reconnect: true });
  }

  findMatch() {
    if (this.net.state === CONN_STATE.DISCONNECTED) { this.net.connect({ reconnect: true }); this.pendingFind = true; const off = this.net.events.on('welcome', () => { off(); if (this.pendingFind) { this.pendingFind = false; this.net.findMatch('AUTO'); } }); return; }
    this.net.findMatch('AUTO');
  }

  /** MATCH_FOUND (also sent on reconnect): build the replica match and report ready. */
  onMatchFound(m) {
    this.mpMenu.showFound(m);
    this.mpMenu.setConnection(CONN_STATE.MATCH_FOUND, m.you.name);
    this.mpMenu.hideResult();
    setTimeout(() => this.startOnlineMatch(m), m.resumed ? 100 : 1800);
  }

  startOnlineMatch(descriptor) {
    this.closePanel();
    this.mainMenu.hide();
    this.resultScreen.hide();
    this.pauseMenu.hide();
    if (this.match) { this.match.dispose(); this.match = null; }
    this.showcase.root.visible = false;
    this.showcaseBall.visible = false;
    this.audio.stopMusic();
    this.hud.reset();
    const initialShiftLock = this.shiftLockSession ?? !!this.settings.get('shiftLockDefault');
    this.match = new OnlineMatch({ sceneManager: this.sceneManager, assets: this.assets, settings: this.settings, audio: this.audio, events: this.events, input: this.input, arena: this.arena, net: this.net, descriptor, initialShiftLock }).start();
    this.state = GAME_STATE.MATCH;
    this.hud.show();
    this.hud.setShiftLock(initialShiftLock);
    this.enterMatchInput();
    if (!descriptor.resumed) this.mpMenu.setCountdown('WAITING FOR OPPONENT');
    else this.mpMenu.setOpponentStatus(null);
  }

  onStartOnline(m) {
    if (!this.match || !this.match.online) return;
    if (m.resumed) { this.mpMenu.setCountdown(null); return; }
    // Countdown synchronised to the server's start timestamp.
    const tick = () => {
      if (!this.match || !this.match.online) return;
      const left = (m.startAt - this.net.serverNow) / 1000;
      if (left > 0.05) { this.mpMenu.setCountdown(String(Math.ceil(left))); setTimeout(tick, 120); }
      else { this.mpMenu.setCountdown('KICK OFF'); this.audio.play('whistle', { volume: 0.6 }); setTimeout(() => this.mpMenu.setCountdown(null), 900); }
    };
    tick();
  }

  onOpponentStatus(o) {
    if (!this.match || !this.match.online) return;
    if (o.status === 'DISCONNECTED') { this.match.setOpponentStatus('DISCONNECTED'); this.mpMenu.setOpponentStatus(`OPPONENT DISCONNECTED<br><small>WAITING UP TO ${o.grace}S FOR THEM TO RETURN</small>`); }
    else { this.match.setOpponentStatus('CONNECTED'); this.mpMenu.setOpponentStatus(o.status === 'RECONNECTED' ? 'OPPONENT RECONNECTED' : null); if (o.status === 'RECONNECTED') setTimeout(() => this.mpMenu.setOpponentStatus(null), 1500); }
  }

  onOnlineMatchEnd(e) {
    if (!this.match || !this.match.online) return;
    const localTeam = this.match.localTeam;
    const won = e.winner === localTeam, lost = e.winner !== null && e.winner !== undefined && !won;
    this.settings.addStats({ matches: 1, wins: won ? 1 : 0, losses: lost ? 1 : 0, draws: e.winner === null || e.winner === undefined ? 1 : 0, goalsFor: e.score[localTeam], goalsAgainst: e.score[1 - localTeam] });
    this.hud.showBanner(e.reason === 'OPPONENT_DISCONNECTED' ? 'MATCH ENDED' : 'FULL TIME', won ? 'YOU WIN' : lost ? 'YOU LOSE' : 'DRAW', '', 2400);
    this.mpMenu.setOpponentStatus(null);
    setTimeout(() => {
      if (!this.match || !this.match.online) return;
      this.state = GAME_STATE.RESULT;
      this.input.wantsPointerLock = false;
      this.input.exitPointerLock();
      this.hud.hide();
      this.touch.setVisible(false);
      this.mpMenu.showResult({ score: e.score, winner: e.winner, localTeam, shootout: e.shootout, reason: e.reason, opponent: this.match.opponentName });
      document.body.style.cursor = 'default';
    }, 2200);
  }

  onRematchMessage(r) {
    if (r.declined) { this.mpMenu.setRematchText('OPPONENT LEFT · FIND A NEW MATCH'); return; }
    if (r.accepted) { this.mpMenu.setRematchText('REMATCH ACCEPTED · TEAMS SWAPPED'); return; }
    if (this.match && r.requestedBy !== this.match.localTeam) this.mpMenu.setRematchText('OPPONENT WANTS A REMATCH · PRESS REMATCH TO ACCEPT');
  }

  leaveOnline() {
    if (this.net && this.net.state !== CONN_STATE.DISCONNECTED) this.net.leave();
    if (this.mpMenu) { this.mpMenu.setCountdown(null); this.mpMenu.setOpponentStatus(null); }
  }

  onFullTime({ score, human, winner, shootout }) {
    if (this.state !== GAME_STATE.MATCH && this.state !== GAME_STATE.PAUSED) return;
    const [b, r] = score;
    const won = winner === TEAM.BLUE, lost = winner === TEAM.RED;
    this.settings.addStats({
      matches: 1, wins: won ? 1 : 0, draws: winner === null || winner === undefined ? 1 : 0, losses: lost ? 1 : 0,
      goalsFor: b, goalsAgainst: r, playerGoals: human.stats.goals, tackles: human.stats.tackles, jukes: human.stats.jukes, shots: human.stats.shots
    });
    this.hud.showBanner(shootout ? 'SHOOTOUT OVER' : 'FULL TIME', won ? 'YOU WIN' : lost ? 'YOU LOSE' : 'DRAW', '', 2400);
    setTimeout(() => {
      if (!this.match) return;
      this.state = GAME_STATE.RESULT;
      this.match.paused = true;
      this.input.wantsPointerLock = false;
      this.input.exitPointerLock();
      this.hud.hide();
      this.touch.setVisible(false);
      this.resultScreen.show({ score, human, winner, shootout });
      document.body.style.cursor = 'default';
    }, 2500);
  }

  onEscape() {
    if (this.state === GAME_STATE.PAUSED) {
      if (this.activePanel) this.closePanel(); else this.resumeMatch();
    } else if (this.state === GAME_STATE.MATCH && !this.input.pointerLocked) {
      this.pauseMatch();
    } else if (this.state === GAME_STATE.MENU && this.activePanel) {
      this.closePanel();
    }
  }

  onPointerLockChange(locked) {
    if (this.state === GAME_STATE.MATCH) {
      this.hud.setPointerHint(!locked);
      // The browser releases the lock on ESC: treat that as pause.
      if (!locked && this.input.wantsPointerLock) this.pauseMatch();
    }
  }

  /** Rolling FPS average; suggest a lower preset once if the device clearly cannot keep up. */
  monitorFps(dt) {
    const f = this.fps;
    f.frames++; f.time += dt;
    if (f.time < 2) return;
    f.avg = f.frames / f.time; f.frames = 0; f.time = 0;
    const q = this.settings.get('graphicsQuality');
    if (f.avg < 24 && q !== 'LOW' && !document.hidden) {
      f.lowSince += 2;
      if (f.lowSince >= 10 && !f.suggested) {
        f.suggested = true;
        this.hud.toast('LOW FRAME RATE · TRY A LOWER GRAPHICS PRESET IN SETTINGS', 4000);
      }
    } else f.lowSince = 0;
  }

  toggleDebug() {
    this.debugEnabled = !this.debugEnabled;
    this.debug.setEnabled(this.debugEnabled);
    if (this.match) { this.match.debugNames = this.debugEnabled; for (const p of this.match.players) p.model.showName(this.debugEnabled || p.isHuman); }
  }

  /* ------------------------------------------------------------ frame loop */

  loop() {
    requestAnimationFrame(() => this.loop());
    this.frame();
    // Keep simulating (without rendering) while the tab is hidden and rAF is throttled.
    if (!this.bgTicker) {
      this.bgTicker = setInterval(() => {
        if (document.hidden || performance.now() - this.lastFrameAt > 250) this.frame(false);
      }, 50);
    }
  }

  frame(render = true) {
    this.lastFrameAt = performance.now();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    try {
      this.update(dt);
    } catch (e) {
      console.error('[Game] update error', e);
    }
    if (render) this.sceneManager.render();
    this.input.endFrame();
  }

  update(dt) {
    switch (this.state) {
      case GAME_STATE.MENU:
        this.cinematic.update(dt);
        this.stadium.update(dt, 0);
        this.showcaseTimer -= dt;
        if (this.showcaseTimer <= 0) {
          this.showcaseTimer = rand(5, 9);
          this.showcaseAnim.playAction(Math.random() < 0.5 ? 'celebrate' : (Math.random() < 0.5 ? 'jukeLeft' : 'hardKick'), { fade: 0.15, duration: Math.random() < 0.5 ? 1.6 : 0.6 });
        }
        this.showcaseAnim.update(dt);
        this.sceneManager.focusShadows(0, 0);
        break;
      case GAME_STATE.MATCH:
        if (this.match.replays.isPlaying && this.input.pressed('SKIP')) this.match.replays.skip();
        this.match.update(dt);
        this.hud.update(this.match, this.audio);
        if (this.touch.visible) {
          this.touch.setContext({ mode: this.hud.controlMode, replay: this.match.replays.isPlaying, shiftLock: this.match.shiftLock && this.match.shiftLock.enabled, shootout: this.match.state === 'PENALTY_SHOOTOUT' });
          this.touch.update(this.match);
        }
        this.monitorFps(dt);
        if (this.debugEnabled) this.debug.update(this.match);
        break;
      case GAME_STATE.PAUSED:
      case GAME_STATE.RESULT:
        if (this.match && this.match.online) {
          // The server keeps playing: keep replicating, but send no input while a menu is open.
          this.match.menuOpen = true;
          this.match.update(dt);
          this.match.menuOpen = false;
          if (this.state === GAME_STATE.PAUSED) this.hud.update(this.match, this.audio);
        } else if (this.match) {
          for (const p of this.match.players) p.anim.update(dt); // frozen: idle animation only
        }
        break;
      default: break;
    }
  }
}
