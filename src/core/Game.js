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
    this.sceneManager = new SceneManager(canvas, this.settings);
    this.scene = this.sceneManager.scene;
    this.input = new InputManager(canvas);
    this.audio = new AudioManager(this.settings);
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

    setTimeout(() => { this.loadingEl.remove(); this.enterMenu(); }, 350);
    this.loop();
  }

  buildArena() {
    this.pitch = new Pitch(this.assets);
    this.goals = [new Goal(-1), new Goal(1)];
    this.stadium = new Stadium();
    this.scene.add(this.pitch.group, this.goals[0].group, this.goals[1].group, this.stadium.group);
    this.arena = { pitch: this.pitch, goals: this.goals, stadium: this.stadium };
  }

  buildUI() {
    const audio = this.audio;
    this.mainMenu = new MainMenu(this.uiRoot, {
      audio,
      onPlay: () => this.startMatch('match'),
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
    this.match = new MatchManager({ sceneManager: this.sceneManager, assets: this.assets, settings: this.settings, audio: this.audio, events: this.events, input: this.input, arena: this.arena, mode }).start();
    this.state = GAME_STATE.MATCH;
    this.hud.show();
    this.input.wantsPointerLock = true;
    this.input.requestPointerLock();
    this.hud.setPointerHint(!this.input.pointerLocked);
    this.hud.showBanner(mode === 'training' ? 'TRAINING' : 'KICK OFF', mode === 'training' ? 'FREE PRACTICE' : `BLUE vs RED · ${Math.round(this.match.duration / 60)} MIN`, '', 2200);
    document.body.style.cursor = 'none';
  }

  pauseMatch() {
    if (this.state !== GAME_STATE.MATCH) return;
    this.state = GAME_STATE.PAUSED;
    this.match.paused = true;
    this.input.wantsPointerLock = false;
    this.input.exitPointerLock();
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
    this.input.wantsPointerLock = true;
    this.input.requestPointerLock(); // called from the click handler so the gesture is valid
    this.input.clearAll();
    document.body.style.cursor = 'none';
  }

  quitToMenu() {
    if (this.match) { this.match.dispose(); this.match = null; }
    this.closePanel();
    this.pauseMenu.hide();
    this.resultScreen.hide();
    this.enterMenu();
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
        if (this.match.replays.isPlaying && this.input.wasPressed('Space')) this.match.replays.skip();
        this.match.update(dt);
        this.hud.update(this.match, this.audio);
        if (this.debugEnabled) this.debug.update(this.match);
        break;
      case GAME_STATE.PAUSED:
      case GAME_STATE.RESULT:
        // Frozen: keep rendering the last frame of the match (players still animate idle).
        if (this.match) for (const p of this.match.players) p.anim.update(dt);
        break;
      default: break;
    }
  }
}
