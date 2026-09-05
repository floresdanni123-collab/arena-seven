import * as THREE from 'three';
import { TeamManager } from './TeamManager.js';
import { GoalSystem } from './GoalSystem.js';
import { RulesManager } from './RulesManager.js';
import { OutOfPlayManager } from './OutOfPlayManager.js';
import { SetPieceManager } from './SetPieceManager.js';
import { ReplayManager } from './ReplayManager.js';
import { PlayerSwitchManager } from './PlayerSwitchManager.js';
import { PenaltyShootoutManager } from './PenaltyShootoutManager.js';
import { Ball } from '../ball/Ball.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { PossessionSystem } from '../ball/PossessionSystem.js';
import { PlayerCamera } from '../camera/PlayerCamera.js';
import { CameraDirector } from '../camera/CameraDirector.js';
import { ShiftLockController } from '../camera/ShiftLockController.js';
import { PlayerController } from '../player/PlayerController.js';
import { GoalkeeperController } from '../player/GoalkeeperController.js';
import { GoalkeeperSkills } from '../player/GoalkeeperSkills.js';
import { AIPlayer } from '../ai/AIPlayer.js';
import { MATCH, TEAM, PLAYER, PITCH, PLAYER_STATE as S, MATCH_STATE, RESTART, FOUL } from '../utils/Constants.js';
import { clamp, damp } from '../utils/MathUtils.js';

export { MATCH_STATE };

const tmp = new THREE.Vector3();
const SET_PIECE_STATES = new Set([MATCH_STATE.FREE_KICK, MATCH_STATE.PENALTY, MATCH_STATE.THROW_IN, MATCH_STATE.CORNER_KICK, MATCH_STATE.GOAL_KICK]);

/**
 * Runs one match. Owns the squads, ball, physics and the per-frame simulation order, and drives the
 * match state machine. Rules, restarts, replays, switching and the shootout live in their own managers;
 * this class only sequences them.
 *
 * Human control is organised in "slots", one per human team (single player: BLUE only; online: both).
 * Each slot has its own controllers and PlayerSwitchManager. `localTeam` marks the slot that owns the
 * camera/HUD on this machine (null on the headless multiplayer server, where every slot is driven by
 * network intents through `controllerFactory`).
 */
export class MatchManager {
  constructor({ sceneManager, assets, settings, audio, events, input, arena, mode = 'match', initialShiftLock = false,
    humanTeams = [TEAM.BLUE], localTeam = TEAM.BLUE, headless = false, roster = null, humanNames = null, difficulty = null, controllerFactory = null, duration = null }) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.assets = assets;
    this.settings = settings;
    this.audio = audio;
    this.events = events;
    this.input = input;
    this.arena = arena;
    this.mode = mode;
    this.training = mode === 'training';
    this.initialShiftLock = initialShiftLock;
    this.humanTeams = humanTeams;
    this.localTeam = localTeam;
    this.headless = headless;
    this.rosterIn = roster;
    this.humanNames = humanNames;
    this.difficultyName = difficulty;
    this.controllerFactory = controllerFactory;

    this.state = MATCH_STATE.KICKOFF;
    this.stateTimer = 0;
    this.clock = 0;
    this.duration = this.training ? Infinity : (duration || (settings ? settings.get('matchDuration') : null) || MATCH.DURATION);
    this.score = [0, 0];
    this.time = 0;
    this.excitement = 0;
    this.lastGoal = null;
    this.lastSave = null;
    this.lastPost = null;
    this.paused = false;
    this.kickoffTeam = TEAM.BLUE;
    this.frozen = true;
    this.subs = [];
    this.pendingRestart = null;
    this.result = null;
    this.debugNames = false;
    this.humans = {};
    this.slots = {};
  }

  start() {
    this.teamManager = new TeamManager({
      assets: this.headless ? null : this.assets, scene: this.scene, settings: this.settings, training: this.training,
      humanTeams: this.humanTeams, localTeam: this.localTeam, headless: this.headless, roster: this.rosterIn, humanNames: this.humanNames, difficulty: this.difficultyName
    }).build();
    this.players = this.teamManager.players;
    this.humans = { ...this.teamManager.humans };
    this.formation = this.teamManager.formation;
    this.roster = this.teamManager.roster;

    this.ball = new Ball(this.headless ? 'headless' : this.assets);
    if (this.scene) this.scene.add(this.ball.group);
    this.physics = new BallPhysics(this.arena.goals);
    this.physics.onBounce = (ball, impact) => this.audio.play('bounce', { volume: clamp(impact / 12, 0.1, 0.6), pitch: this.audio.randomPitch(0.15) });
    this.physics.onPost = (ball, speed, name, goal) => this.onPost(speed, name, goal);
    this.physics.onBoard = (ball, speed) => this.audio.play('bounce', { volume: clamp(speed / 15, 0.1, 0.5), pitch: 0.6 });
    this.physics.onKeeperBlock = (ball, keeper, speed) => {
      keeper.stats.saves++;
      this.audio.play('save', { volume: 0.7 });
      this.events.emit('save', { player: keeper, type: 'block', dive: keeper.sm.is(S.DIVING), shotSpeed: speed });
    };
    this.possession = new PossessionSystem();
    this.goalSystem = new GoalSystem(this.arena.goals, this.events);

    // Cameras (harmless but unused on the server)
    this.camera = new PlayerCamera(this.sceneManager.camera, this.settings || { get: () => 1 });
    this.cameraDirector = new CameraDirector(this.sceneManager.camera);
    this.cameraDirector.register('gameplay', this.camera);

    // Shift lock (C): owned here so it survives switching, set pieces and replays.
    this.shiftLock = new ShiftLockController(this.camera, this.events, this.initialShiftLock);
    this.camera.shiftLock = this.shiftLock;

    // Managers
    this.rules = new RulesManager(this);
    this.outOfPlay = new OutOfPlayManager(this.arena.goals);
    this.setPieces = new SetPieceManager(this);
    this.replays = new ReplayManager(this);
    this.cameraDirector.register('replay', this.replays.camera);
    this.shootout = new PenaltyShootoutManager(this);

    this.world = {
      ball: this.ball, players: this.players, possession: this.possession, audio: this.audio, events: this.events,
      time: 0, goals: this.arena.goals, match: this, formation: this.formation, teamAIs: this.teamManager.teamAIs, rules: this.rules
    };
    for (const p of this.players) if (p.ai && p.ai.setWorld) p.ai.setWorld(this.world);

    // Control slots: one per human team.
    for (const team of this.humanTeams) {
      const slot = { team, human: this.humans[team], switcher: new PlayerSwitchManager(this, team) };
      if (this.controllerFactory) {
        const made = this.controllerFactory(team, this);
        slot.controller = made.controller; slot.gkController = made.gkController;
      } else {
        slot.controller = new PlayerController(this.input, this.camera);
        slot.gkController = new GoalkeeperController(this.input, this.camera);
      }
      for (const ctrl of [slot.controller, slot.gkController]) {
        ctrl.onSwitchRequest = () => slot.switcher.nearestToBall();
        ctrl.onCycleRequest = () => { slot.switcher.cycle(1); this.setPieces.applyControllerMode(); };
        ctrl.onToast = (t) => { if (team === this.localTeam) this.events.emit('toast', { text: t }); };
        ctrl.shiftLock = team === this.localTeam ? this.shiftLock : null;
        ctrl.setPieces = this.setPieces;
      }
      slot.activeController = slot.controller;
      this.slots[team] = slot;
      this.useController(team, slot.human);
    }

    this.subs.push(this.events.on('goal', (d) => this.onGoal(d)));
    this.subs.push(this.events.on('kick', (d) => this.onKick(d)));
    this.subs.push(this.events.on('save', (d) => { this.lastSave = { time: this.time, data: d }; }));
    this.subs.push(this.events.on('tackle_hit', (d) => { if (d.player === this.human || d.victim === this.human) this.camera.addShake(0.35); }));

    this.setupKickoff(TEAM.BLUE, true);
    this.audio.startAmbience('crowd', 0.3);
    return this;
  }

  /* ------------------------------------------------------------ slots / helpers used by managers */

  /** The human this machine controls (camera/HUD). On the server: the BLUE human as a stand-in. */
  get human() { return this.humans[this.localTeam ?? TEAM.BLUE] || this.humans[TEAM.RED] || this.players[0]; }
  get localSlot() { return this.slots[this.localTeam ?? TEAM.BLUE] || this.slotList()[0]; }
  get controller() { return this.localSlot.controller; }
  get gkController() { return this.localSlot.gkController; }
  get switcher() { return this.localSlot.switcher; }
  get activeController() { return this.localSlot.activeController; }
  slotList() { return Object.values(this.slots); }
  setHuman(team, p) { this.humans[team] = p; if (this.slots[team]) this.slots[team].human = p; this.teamManager.humans[team] = p; if (team === this.localTeam) this.teamManager.human = p; }
  isOpenPlay() { return this.state === MATCH_STATE.PLAYING; }
  makeOutfieldAI(p) { return new AIPlayer(p, this.teamManager.teamAIs[p.team], this.teamManager.difficulty); }

  useController(team, player) {
    const slot = this.slots[team];
    if (!slot || !player) return;
    const ctrl = player.isGoalkeeper ? slot.gkController : slot.controller;
    if (slot.activeController && slot.activeController !== ctrl) slot.activeController.setPlayer(null);
    slot.activeController = ctrl;
    ctrl.setPlayer(player);
  }

  enterState(state, timer = 0) { this.state = state; this.stateTimer = timer; this.events.emit('match_state', { state, timer }); }

  /* ------------------------------------------------------------ flow: kickoff / play */

  setupKickoff(kickingTeam, first = false) {
    this.kickoffTeam = kickingTeam;
    this.enterState(MATCH_STATE.KICKOFF, first ? MATCH.KICKOFF_DELAY + 0.8 : MATCH.KICKOFF_DELAY);
    this.frozen = true;
    this.setPieces.cancel();
    this.rules.reset();
    this.possession.release(this.ball);
    this.ball.reset(0, 0);
    this.goalSystem.reset();
    for (const p of this.players) {
      p.resetState();
      this.formation.getKickoffPosition(p.team, p.slotIndex, p.team === kickingTeam, tmp);
      const yaw = p.team === TEAM.BLUE ? 0 : Math.PI;
      p.teleport(tmp.x, tmp.z, yaw);
      p.homePosition.copy(tmp);
      p.targetPosition.copy(tmp);
      if (p.ai) { if (p.ai.moveTarget) p.ai.moveTarget.copy(tmp); p.ai.threat = null; p.ai.mode = 'POSITION'; }
    }
    this.camera.setRig(this.human.isGoalkeeper ? 'keeper' : 'player');
    this.camera.setTarget(this.human, true);
    this.cameraDirector.setActive('gameplay', first ? 0 : 0.8);
    for (const slot of this.slotList()) { slot.controller.mode = 'normal'; slot.gkController.mode = 'normal'; }
    this.events.emit('kickoff_setup', { team: kickingTeam, first });
  }

  beginPlay() {
    this.enterState(MATCH_STATE.PLAYING);
    this.frozen = false;
    this.audio.play('whistle', { volume: 0.7 });
    this.events.emit('kickoff', { team: this.kickoffTeam });
  }

  resumePlay() {
    this.enterState(MATCH_STATE.PLAYING);
    this.frozen = false;
    this.possession.locked = false;
    this.ball.frozen = false;
    this.pendingRestart = null;
    this.camera.setRig(this.human.isGoalkeeper ? 'keeper' : 'player');
    this.cameraDirector.setActive('gameplay', 0.5);
    this.events.emit('play_resumed', {});
  }

  /* ------------------------------------------------------------ flow: goals */

  onGoal({ team, scorer, ownGoal }) {
    if (this.shootout.active) { this.shootout.onGoal(team); return; }
    if (this.state !== MATCH_STATE.PLAYING) return;
    this.score[team]++;
    this.enterState(MATCH_STATE.GOAL, 1.3);
    this.frozen = true;
    this.excitement = 1;
    const goalSide = team === TEAM.BLUE ? 1 : -1;
    this.lastGoal = { team, scorer, ownGoal, time: this.clock, eventTime: this.time, goalSide, shot: this.replays.recentShot(4.5, goalSide) };
    if (scorer && !ownGoal) scorer.stats.goals++;
    this.audio.play('goal', { volume: 1 });
    this.audio.setAmbienceLevel('crowd', 0.8, 0.3);
    this.camera.addShake(0.5);
    for (const p of this.players) {
      p.cancelCharge(); p.pendingKick = null;
      if (p.team === team && !p.sm.isDown()) p.celebrate(MATCH.GOAL_FREEZE);
      p.setMoveInput(0, 0, false);
    }
    this.events.emit('goal_scored', { team, scorer, ownGoal, score: [...this.score] });
  }

  startGoalReplay() {
    const g = this.lastGoal;
    this.enterState(MATCH_STATE.GOAL_REPLAY);
    const started = this.replays.play({
      kind: 'goal', eventTime: g.eventTime, shot: g.shot, goalSide: g.goalSide,
      onComplete: () => this.showGoalUI()
    });
    if (started) { this.cameraDirector.setActive('replay', 0.5); this.lockSwitching(true); }
    else this.showGoalUI();
  }

  showGoalUI() {
    this.lockSwitching(false);
    this.cameraDirector.setActive('gameplay', 0.6);
    this.enterState(MATCH_STATE.GOAL_UI, 2.2);
    this.events.emit('goal_ui', { ...this.lastGoal, score: [...this.score] });
  }

  lockSwitching(v) { for (const slot of this.slotList()) slot.switcher.locked = v; }

  /* ------------------------------------------------------------ flow: out of play / fouls */

  onPost(speed, name, goal) {
    this.lastPost = { time: this.time, name, side: goal.side, speed };
    this.audio.play('post', { volume: clamp(speed / 20, 0.3, 1) });
    this.events.emit('post', { speed, name, side: goal.side });
    this.camera.addShake(0.15);
  }

  onBallOut(d) {
    if (this.state !== MATCH_STATE.PLAYING) return;
    this.pendingRestart = { type: d.type, team: d.team, position: d.position };
    this.frozen = true;
    this.ball.frozen = true;
    this.possession.locked = true;
    this.audio.play('whistle', { volume: 0.4 });
    this.events.emit('ball_out', d);

    const goalSide = Math.sign(d.exitPoint.z) || 1;
    const shot = this.replays.recentShot(4, goalSide);
    const recentSave = this.lastSave && this.time - this.lastSave.time < 3.5 ? this.lastSave.data : null;
    const hitPost = this.lastPost && this.time - this.lastPost.time < 3 && this.lastPost.side === goalSide;
    let kind = null;
    if (d.type === RESTART.CORNER && d.keeperTouched && recentSave && this.replays.isSignificantSave(recentSave)) kind = 'save';
    else if ((d.type === RESTART.CORNER || d.type === RESTART.GOAL_KICK) && shot && this.replays.isSignificantMiss(shot, d.exitPoint, hitPost)) kind = 'miss';
    if (kind) {
      this.enterState(kind === 'save' ? MATCH_STATE.SAVE_REPLAY : MATCH_STATE.MISSED_SHOT_REPLAY);
      const started = this.replays.play({ kind, eventTime: kind === 'save' ? this.lastSave.time : this.time, shot, goalSide, onComplete: () => this.beginPendingRestart() });
      if (started) { this.cameraDirector.setActive('replay', 0.5); this.lockSwitching(true); return; }
    }
    this.beginPendingRestart(0.9);
  }

  onFoulAwarded(spec) {
    if (!this.isOpenPlay()) return;
    this.pendingRestart = spec;
    this.enterState(MATCH_STATE.FOUL_STOPPAGE, FOUL.STOPPAGE_TIME);
    this.frozen = true;
    this.ball.frozen = true;
    this.possession.release(this.ball);
    this.possession.locked = true;
    this.audio.play('whistle', { volume: 0.8 });
    for (const p of this.players) { p.cancelCharge(); p.pendingKick = null; }
    this.events.emit('foul_awarded', spec);
  }

  beginPendingRestart(delay = 0) {
    this.lockSwitching(false);
    const spec = this.pendingRestart;
    if (!spec) { this.resumePlay(); return; }
    if (delay > 0) { this.enterState(MATCH_STATE.FOUL_STOPPAGE, delay); this.stoppageIsOut = true; return; }
    this.pendingRestart = null;
    this.setPieces.begin(spec);
  }

  sendOff(player) {
    if (!player.active) return;
    player.active = false;
    player.resetState();
    player.setMoveInput(0, 0, false);
    const idx = this.players.indexOf(player);
    if (idx >= 0) this.players.splice(idx, 1);
    const teamAI = this.teamManager.teamAIs[player.team];
    teamAI.players = teamAI.players.filter((p) => p !== player);
    this.teamManager.teams[player.team] = this.teamManager.teams[player.team].filter((p) => p !== player);
    if (this.ball.owner === player) this.possession.release(this.ball);
    player.teleport(-(PITCH.HALF_WIDTH + 6), 0, 0);
    player.model.root.visible = false;
    if (player.isHuman && this.slots[player.team]) {
      const next = this.players.find((p) => p.team === player.team && !p.isGoalkeeper) || this.players.find((p) => p.team === player.team);
      if (next) this.slots[player.team].switcher.switchTo(next, { reason: 'sendoff' });
    }
    this.events.emit('send_off', { player });
  }

  onKick(d) {
    this.replays.noteKick(d);
    if (this.setPieces.isActive()) this.setPieces.onTakerKick(d);
    if (!this.shootout.active) for (const slot of this.slotList()) slot.switcher.onKick(d);
  }

  /* ------------------------------------------------------------ flow: full time */

  fullTime() {
    this.frozen = true;
    for (const p of this.players) p.setMoveInput(0, 0, false);
    if (!this.training && this.score[0] === this.score[1]) {
      this.enterState(MATCH_STATE.FULLTIME, 2.6);
      this.audio.play('whistle_long', { volume: 0.8 });
      this.events.emit('fulltime_tied', { score: [...this.score] });
      return;
    }
    this.finishMatch({ winner: this.score[0] > this.score[1] ? TEAM.BLUE : this.score[0] < this.score[1] ? TEAM.RED : null });
  }

  finishMatch(result) {
    this.setPieces.cancel();
    this.enterState(MATCH_STATE.MATCH_FINISHED);
    this.frozen = true;
    this.result = { ...result, score: [...this.score] };
    if (!result.shootout) this.audio.play('whistle_long', { volume: 0.8 });
    for (const p of this.players) p.setMoveInput(0, 0, false);
    this.events.emit('fulltime', { score: [...this.score], human: this.human, players: this.players, winner: result.winner, shootout: result.shootout || null, reason: result.reason || null });
  }

  /* ------------------------------------------------------------ per-frame */

  update(dt) {
    if (this.paused) return;
    this.time += dt;
    this.world.time = this.time;
    this.excitement = damp(this.excitement, 0, 0.8, dt);

    // Replays: recorded state only. No physics, AI or input.
    if (this.replays.isPlaying) {
      this.replays.update(dt);
      this.cameraDirector.update(dt);
      this.arena.stadium.update(dt, this.excitement);
      return;
    }

    switch (this.state) {
      case MATCH_STATE.KICKOFF:
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.beginPlay();
        break;
      case MATCH_STATE.PLAYING:
        this.clock += dt;
        this.rules.update(dt);
        if (this.clock >= this.duration) this.fullTime();
        break;
      case MATCH_STATE.GOAL:
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.startGoalReplay();
        break;
      case MATCH_STATE.GOAL_UI:
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.audio.setAmbienceLevel('crowd', 0.3, 1.5);
          this.setupKickoff(this.lastGoal.team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE);
        }
        break;
      case MATCH_STATE.FOUL_STOPPAGE:
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) { this.stoppageIsOut = false; this.beginPendingRestart(); }
        break;
      case MATCH_STATE.FULLTIME:
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.shootout.start();
        break;
      case MATCH_STATE.PENALTY_SHOOTOUT:
        this.shootout.update(dt);
        break;
      default:
        if (SET_PIECE_STATES.has(this.state)) this.setPieces.update(dt);
    }

    const playing = this.state === MATCH_STATE.PLAYING;
    const setPiece = this.setPieces.isActive();
    const shootoutLive = this.state === MATCH_STATE.PENALTY_SHOOTOUT;
    const interactive = playing || setPiece || shootoutLive;

    // Local-only keys: C toggles shift lock, R resets the training ball.
    if (this.input) {
      if (this.input.pressed('SHIFT_LOCK')) this.shiftLock.toggle();
      if (this.training && playing && this.input.pressed('RESET_BALL')) {
        this.possession.release(this.ball);
        this.ball.reset(this.human.position.x + this.human.facingDir.x * 1.5, this.human.position.z + this.human.facingDir.z * 1.5);
      }
    }

    // Intents
    if (interactive) {
      for (const slot of this.slotList()) { slot.activeController.enabled = true; slot.activeController.update(dt, this.world); }
      if (playing) for (const ai of this.teamManager.teamAIs) ai.update(dt, this.world);
      for (const p of this.players) if (p.ai && !p.isHuman) p.ai.update(dt, this.world);
      if (setPiece) this.setPieces.update(0); // re-apply set-piece driving after controllers/AI
    } else {
      if (this.input) { const md = this.input.consumeMouseDelta(); this.camera.applyMouse(md.x, md.y); }
      for (const p of this.players) p.setMoveInput(0, 0, false);
    }

    // Simulation
    for (const p of this.players) p.update(dt, this.world);
    for (const p of this.players) p.updateRelease(dt, this.world);
    for (const p of this.players) {
      if (p.isGoalkeeper && p.isHuman && p.sm.is(S.DIVING)) GoalkeeperSkills.updateDiveContact(this.world, p, dt, { catchSkill: 1, reach: 1.05 });
    }
    this.separatePlayers();
    if (!this.frozen || this.state === MATCH_STATE.GOAL) this.physics.step(this.ball, dt, this.players);
    this.possession.update(dt, this.ball, this.players, this.time);
    this.ball.update(dt);
    if (playing || shootoutLive) this.goalSystem.update(this.ball);
    if (playing) {
      const out = this.outOfPlay.check(this.ball);
      if (out) this.onBallOut(out);
      this.checkStuckBall(dt);
    }
    if (!this.frozen || setPiece || shootoutLive) this.replays.record(dt);

    // Presentation
    this.camera.update(dt);
    this.cameraDirector.update(dt);
    this.sceneManager.focusShadows(this.human.position.x, this.human.position.z);
    this.arena.stadium.update(dt, this.excitement);
  }

  /** A dead ball behind a goal line that the out-of-play check somehow missed is nudged back. */
  checkStuckBall(dt) {
    const b = this.ball;
    const behind = Math.abs(b.position.z) > PITCH.HALF_LENGTH + 0.2;
    const dead = !b.owner && b.speed < 0.3;
    if (behind && dead) {
      this.stuckTimer = (this.stuckTimer || 0) + dt;
      if (this.stuckTimer > 2.5) {
        const s = Math.sign(b.position.z) || 1;
        let x = clamp(b.position.x, -PITCH.HALF_WIDTH + 2, PITCH.HALF_WIDTH - 2);
        if (Math.abs(x) < PITCH.GOAL_WIDTH / 2 + 1) x = Math.sign(x || 1) * (PITCH.GOAL_WIDTH / 2 + 2.5);
        this.possession.release(b);
        b.reset(x, s * (PITCH.HALF_LENGTH - 2));
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  /** Soft separation so players don't overlap. Sliding/diving players push others. */
  separatePlayers() {
    const n = this.players.length;
    const minD = PLAYER.SEPARATION;
    for (let i = 0; i < n; i++) {
      const a = this.players[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.players[j];
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        const aFixed = a.sm.is(S.TACKLING) || a.sm.is(S.DIVING) || a.locked;
        const bFixed = b.sm.is(S.TACKLING) || b.sm.is(S.DIVING) || b.locked;
        const wa = aFixed && !bFixed ? 0 : bFixed && !aFixed ? 1 : 0.5;
        a.position.x -= nx * push * 2 * wa; a.position.z -= nz * push * 2 * wa;
        b.position.x += nx * push * 2 * (1 - wa); b.position.z += nz * push * 2 * (1 - wa);
      }
    }
  }

  get clockText() {
    if (this.training) { const m = Math.floor(this.clock / 60), s = Math.floor(this.clock % 60); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
    const remaining = Math.max(0, this.duration - this.clock);
    const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  dispose() {
    for (const off of this.subs) off();
    this.shootout.active = false;
    this.teamManager.dispose();
    if (this.scene) this.scene.remove(this.ball.group);
    this.audio.stopAmbience('crowd');
  }
}
