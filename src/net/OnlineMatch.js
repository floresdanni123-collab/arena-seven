import * as THREE from 'three';
import { TeamManager } from '../match/TeamManager.js';
import { ReplayManager } from '../match/ReplayManager.js';
import { Ball } from '../ball/Ball.js';
import { PlayerCamera } from '../camera/PlayerCamera.js';
import { CameraDirector } from '../camera/CameraDirector.js';
import { ShiftLockController } from '../camera/ShiftLockController.js';
import { PlayerController } from '../player/PlayerController.js';
import { GoalkeeperController } from '../player/GoalkeeperController.js';
import { intentHasAction } from '../player/PlayerIntent.js';
import { SnapshotBuffer } from './SnapshotBuffer.js';
import { NET, STATE_CODES, BALL_STATE_CODES, ACTION_CODES, CONTROL_MODES } from './Protocol.js';
import { MATCH_STATE, TEAM, PLAYER_STATE as S, BALL_STATE } from '../utils/Constants.js';
import { clamp, damp } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const FORCED_STATES = new Set([S.FALLING, S.STUNNED, S.RECOVERING, S.HOLDING, S.THROWING, S.CELEBRATING]);

/**
 * Client-side replica of an online match. The server owns the simulation; this class renders it:
 *   - remote players and the ball are interpolated between snapshots (rendered NET.INTERP_DELAY behind)
 *   - the locally controlled player is predicted from local input and reconciled against the server
 *   - gameplay events from the server are re-emitted on the local EventBus so HUD, audio and replays
 *     behave exactly as in single player (replays are reconstructed from the replicated state)
 * It exposes the same surface the HUD / Game use on MatchManager (state, score, clockText, human...).
 */
export class OnlineMatch {
  constructor({ sceneManager, assets, settings, audio, events, input, arena, net, descriptor, initialShiftLock = false }) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.assets = assets;
    this.settings = settings;
    this.audio = audio;
    this.events = events;
    this.input = input;
    this.arena = arena;
    this.net = net;
    this.descriptor = descriptor;
    this.localTeam = descriptor.team;
    this.online = true;
    this.training = false;
    this.mode = 'online';
    this.paused = false;
    this.state = MATCH_STATE.KICKOFF;
    this.score = [0, 0];
    this.clock = 0;
    this.duration = descriptor.duration || 300;
    this.time = 0;
    this.excitement = 0;
    this.poss = 0.5;
    this.humans = {};
    this.debugNames = false;
    this.initialShiftLock = initialShiftLock;
    this.buffer = new SnapshotBuffer();
    this.seq = 0;
    this.sendAccumulator = 0;
    this.history = [];
    this.correction = new THREE.Vector3();
    this.lastAck = 0;
    this.remoteAction = new Map();   // player -> last applied action id
    this.setPiece = null;
    this.subs = [];
    this.netSubs = [];
    this.started = false;
    this.countdown = null;
    this.opponentStatus = 'CONNECTED';
    this.stats = { packets: 0, serverTick: 0 };
  }

  start() {
    const d = this.descriptor;
    this.teamManager = new TeamManager({
      assets: this.assets, scene: this.scene, settings: this.settings, humanTeams: [TEAM.BLUE, TEAM.RED], localTeam: this.localTeam,
      roster: d.roster, humanNames: { [this.localTeam]: d.you.name, [1 - this.localTeam]: d.opponent.name }, difficulty: d.difficulty
    }).build();
    this.players = this.teamManager.players;
    this.byId = new Map(this.players.map((p) => [p.id, p]));
    this.humans = { ...this.teamManager.humans };
    this.formation = this.teamManager.formation;
    // Nobody runs AI here; every player is replicated. Mark humans so name tags / markers show.
    for (const p of this.players) p.speedMult = 1;
    const opp = this.humans[1 - this.localTeam];
    if (opp) { opp.model.showName(true); opp.model.setMarker(opp.team === TEAM.BLUE ? 0x2f7bff : 0xff3b4e); }

    this.ball = new Ball(this.assets);
    this.scene.add(this.ball.group);
    this.possession = { possessionShare: () => this.poss, locked: false, release: () => {}, assign: () => {} };

    this.camera = new PlayerCamera(this.sceneManager.camera, this.settings);
    this.cameraDirector = new CameraDirector(this.sceneManager.camera);
    this.cameraDirector.register('gameplay', this.camera);
    this.shiftLock = new ShiftLockController(this.camera, this.events, this.initialShiftLock);
    this.camera.shiftLock = this.shiftLock;

    this.controller = new PlayerController(this.input, this.camera);
    this.gkController = new GoalkeeperController(this.input, this.camera);
    for (const c of [this.controller, this.gkController]) {
      c.shiftLock = this.shiftLock;
      c.setPieces = { requestPenaltyShot: () => true };  // the server runs the run-up; the intent carries the shot
      c.onCycleRequest = null; c.onSwitchRequest = null; // switching is decided by the server from the intent
      c.onToast = (t) => this.events.emit('toast', { text: t });
    }
    this.activeController = this.controller;
    this.useController(this.human);

    this.world = {
      ball: this.ball, players: this.players, possession: this.possession, audio: this.audio, events: this.events,
      time: 0, goals: this.arena.goals, match: this, formation: this.formation, teamAIs: this.teamManager.teamAIs, rules: null, replica: true
    };
    this.replays = new ReplayManager(this);
    this.cameraDirector.register('replay', this.replays.camera);

    // Network
    this.netSubs.push(this.net.events.on('snapshot', (s) => this.onSnapshot(s)));
    this.netSubs.push(this.net.events.on('event', (e) => this.onServerEvent(e)));
    this.netSubs.push(this.net.events.on('start_match', (m) => this.onStartMatch(m)));

    this.camera.setRig(this.human.isGoalkeeper ? 'keeper' : 'player');
    this.camera.setTarget(this.human, true);
    this.cameraDirector.setActive('gameplay', 0);
    this.placeKickoff();
    this.audio.startAmbience('crowd', 0.3);
    this.net.ready();
    return this;
  }

  /* ------------------------------------------------------------ MatchManager-compatible surface */

  get human() { return this.humans[this.localTeam]; }
  get slots() { return { [this.localTeam]: { team: this.localTeam, human: this.human } }; }
  slotList() { return Object.values(this.slots); }
  get setPieces() { return { isActive: () => !!this.setPiece, type: this.setPiece ? this.setPiece.ty : null, phase: this.setPiece ? this.setPiece.ph : null }; }
  get clockText() {
    const remaining = Math.max(0, this.duration - this.clock);
    const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  get ping() { return this.net.ping; }
  get opponentName() { return this.descriptor.opponent.name; }

  useController(player) {
    if (!player) return;
    const ctrl = player.isGoalkeeper ? this.gkController : this.controller;
    if (this.activeController !== ctrl) this.activeController.setPlayer(null);
    this.activeController = ctrl;
    ctrl.setPlayer(player);
  }

  placeKickoff() {
    for (const p of this.players) {
      this.formation.getKickoffPosition(p.team, p.slotIndex, p.team === TEAM.BLUE, tmp);
      p.teleport(tmp.x, tmp.z, p.team === TEAM.BLUE ? 0 : Math.PI);
    }
    this.ball.reset(0, 0);
  }

  onStartMatch(m) { this.startAt = m.startAt; this.started = true; }

  /* ------------------------------------------------------------ inbound */

  onSnapshot(s) {
    this.stats.packets++;
    this.stats.serverTick = s.k;
    this.buffer.push(s);
    // Authoritative match-level state is applied immediately (not interpolated).
    this.state = s.ms;
    this.score[0] = s.sc[0]; this.score[1] = s.sc[1];
    this.poss = s.poss;
    this.lastSnapshotClock = { clk: s.clk, st: s.st, playing: s.ms === MATCH_STATE.PLAYING };
    this.setPiece = s.sp;
    // Controlled players (server decides): switch our camera/controller when ours changes.
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const id = s.ctl[team];
      const p = this.byId.get(id);
      if (p && this.humans[team] !== p) this.applySwitch(team, p);
    }
    // Local control mode mirrors the server's (hold / setpiece / throwin / penalty / normal).
    const mode = CONTROL_MODES[s.md[this.localTeam]] || 'normal';
    if (this.controller.mode !== mode) { this.controller.mode = mode; this.gkController.mode = mode === 'hold' ? 'setpiece' : mode; }
    // Reconcile local prediction against the server's view of our player.
    this.lastAck = s.seq[this.localTeam];
    this.reconcile(s);
  }

  applySwitch(team, p) {
    const old = this.humans[team];
    if (old) { old.isHuman = false; old.model.setMarker(null); old.model.showName(this.debugNames); }
    p.isHuman = true;
    this.humans[team] = p;
    const local = team === this.localTeam;
    p.model.showName(true);
    p.model.setMarker(local ? 0xb8ff3b : (team === TEAM.BLUE ? 0x2f7bff : 0xff3b4e));
    if (local) {
      this.useController(p);
      this.camera.setRig(p.isGoalkeeper ? 'keeper' : (this.setPiece ? 'setpiece' : 'player'), this.camera.focusPoint);
      this.camera.setTarget(p, false);
      this.history.length = 0; this.correction.set(0, 0, 0);
    }
  }

  reconcile(s) {
    const me = this.human;
    if (!me) return;
    const e = s.pl.find((row) => row[0] === me.id);
    if (!e) return;
    const ack = s.seq[this.localTeam];
    // Trim history up to the acked input and compare where we thought we were.
    while (this.history.length && this.history[0].seq < ack) this.history.shift();
    const h = this.history.length && this.history[0].seq === ack ? this.history[0] : null;
    const predicting = this.isPredicting() && this.started && !this.menuOpen;
    if (!predicting) { this.history.length = 0; this.correction.set(0, 0, 0); return; } // fully replicated: interpolation handles it
    const px = h ? h.x : me.position.x, pz = h ? h.z : me.position.z;
    const ex = e[1] - px, ez = e[2] - pz;
    const err = Math.hypot(ex, ez);
    if (err > 3.0) { me.position.x = e[1]; me.position.z = e[2]; this.correction.set(0, 0, 0); this.history.length = 0; }
    else if (err > 0.05) { this.correction.x += ex; this.correction.z += ez; for (const hh of this.history) { hh.x += ex; hh.z += ez; } }
    // Never let pending corrections pile up beyond a snap distance.
    if (this.correction.length() > 3.0) { me.position.x = e[1]; me.position.z = e[2]; this.correction.set(0, 0, 0); this.history.length = 0; }
    // Forced server states (knocked down, holding, celebrating...) override local prediction.
    const st = STATE_CODES[e[6]];
    if (FORCED_STATES.has(st) && me.sm.state !== st) {
      me.sm.set(st, 0);
      this.playServerAction(me, e, true);
    }
    me.hasBall = !!(e[10] & 1);
    me.locked = !!(e[10] & 16);
  }

  isPredicting() {
    const me = this.human;
    return !!me && this.state === MATCH_STATE.PLAYING && !me.locked && this.controller.mode === 'normal' && this.opponentStatus !== 'DISCONNECTED';
  }

  onServerEvent(e) {
    const name = e.name;
    const data = this.resolve(e.data);
    switch (name) {
      case 'replay_start': {
        // Reconstruct the same replay from our replicated buffer. Times are in server match time.
        const shot = data.shot ? { time: data.shot.time, player: data.shot.player, position: new THREE.Vector3().fromArray(data.shot.position), velocity: new THREE.Vector3().fromArray(data.shot.velocity), team: data.shot.team } : null;
        const started = this.replays.play({ kind: data.kind, eventTime: data.eventTime, shot, goalSide: data.goalSide, onComplete: () => { this.cameraDirector.setActive('gameplay', 0.6); } });
        if (started) this.cameraDirector.setActive('replay', 0.5);
        break;
      }
      case 'replay_end':
        if (this.replays.isPlaying) this.replays.skip();
        this.cameraDirector.setActive('gameplay', 0.6);
        break;
      case 'set_piece':
        this.camera.setRig('setpiece', new THREE.Vector3().fromArray(data.position));
        this.cameraDirector.setActive('gameplay', 0.7);
        break;
      case 'play_resumed': case 'kickoff_setup':
        this.camera.setRig(this.human && this.human.isGoalkeeper ? 'keeper' : 'player');
        this.cameraDirector.setActive('gameplay', 0.5);
        break;
      case 'kick': this.audio.play(data.type === 'hard' || data.type === 'kick' ? 'kick' : 'pass', { volume: 0.7, pitch: this.audio.randomPitch(0.1) }); break;
      case 'tackle_hit': this.audio.play('tackle', { volume: 1 }); if (data.player === this.human || data.victim === this.human) this.camera.addShake(0.35); break;
      case 'goal_scored': this.audio.play('goal', { volume: 1 }); this.excitement = 1; this.camera.addShake(0.5); this.lastGoal = data; break;
      case 'post': this.audio.play('post', { volume: 0.7 }); this.camera.addShake(0.15); break;
      case 'foul_awarded': case 'ball_out': this.audio.play('whistle', { volume: 0.6 }); break;
      case 'kickoff': this.audio.play('whistle', { volume: 0.7 }); break;
      case 'save': this.audio.play(data.type === 'catch' ? 'catch' : 'save', { volume: 0.8 }); break;
      case 'juke_success': this.audio.play('juke', { volume: 0.9 }); break;
      case 'card': this.audio.play('whistle', { volume: 0.6 }); break;
      case 'shootout_kick': this.audio.play(data.scored ? 'goal' : 'crowd_ooh', { volume: 0.8 }); break;
      case 'match_state': this.state = data.state; break;
      default: break;
    }
    this.events.emit(name, data);
  }

  /** Turn serialised player refs ({$p: id}) back into Player objects. */
  resolve(v, depth = 0) {
    if (v === null || v === undefined || typeof v !== 'object' || depth > 4) return v;
    if (Array.isArray(v)) return v.map((x) => this.resolve(x, depth + 1));
    if ('$p' in v) return this.byId.get(v.$p) || v;
    const out = {};
    for (const k of Object.keys(v)) out[k] = this.resolve(v[k], depth + 1);
    return out;
  }

  /* ------------------------------------------------------------ per-frame */

  update(dt) {
    if (this.paused) return;
    this.lastDt = dt;
    const renderTime = this.net.serverNow - NET.INTERP_DELAY * 1000;
    const { a, b, k, extrapolate } = this.buffer.sample(renderTime);
    if (a) this.time = b ? a.mt + (b.mt - a.mt) * k : a.mt + (extrapolate || 0);
    this.world.time = this.time;
    this.excitement = damp(this.excitement, 0, 0.8, dt);
    // Clock: server clock extrapolated locally while playing.
    if (this.lastSnapshotClock) {
      const lc = this.lastSnapshotClock;
      this.clock = lc.playing ? lc.clk + Math.max(0, (this.net.serverNow - lc.st) / 1000) : lc.clk;
    }

    if (this.replays.isPlaying) {
      this.replays.update(dt);
      this.cameraDirector.update(dt);
      this.arena.stadium.update(dt, this.excitement);
      return;
    }

    if (this.input.pressed('SHIFT_LOCK')) this.shiftLock.toggle();

    // 1. Local input: predict + send.
    const me = this.human;
    const live = this.started && !this.menuOpen && (this.state === MATCH_STATE.PLAYING || !!this.setPiece || this.state === MATCH_STATE.PENALTY_SHOOTOUT);
    if (live && me) {
      this.activeController.enabled = true;
      this.activeController.update(dt, this.world);
      this.sendIntent(dt);
    } else {
      const md = this.input.consumeMouseDelta();
      this.camera.applyMouse(md.x, md.y);
      if (me) me.setMoveInput(0, 0, false);
    }

    // 2. Apply snapshots to every replicated player; predict our own.
    const predicting = this.isPredicting() && live;
    if (a) this.applyReplicated(a, b, k, predicting ? me : null, extrapolate || 0);
    if (me && predicting) {
      me.update(dt, this.world);
      // consume the reconciliation correction smoothly
      const cx = this.correction.x * Math.min(1, dt * 12), cz = this.correction.z * Math.min(1, dt * 12);
      me.position.x += cx; me.position.z += cz; this.correction.x -= cx; this.correction.z -= cz;
      me.model.root.position.copy(me.position);
      me.model.root.rotation.y = me.facing;
    }

    // 3. Ball
    if (a) this.applyBall(a, b, k, extrapolate || 0);
    this.ball.group.position.copy(this.ball.position);
    this.ball.updateShadowOnly?.();

    // 4. Presentation
    this.replays.record(dt);
    this.camera.update(dt);
    this.cameraDirector.update(dt);
    this.sceneManager.focusShadows(me ? me.position.x : 0, me ? me.position.z : 0);
    this.arena.stadium.update(dt, this.excitement);
  }

  sendIntent(dt) {
    const it = this.activeController.lastIntent;
    if (!it) return;
    this.sendAccumulator += dt;
    const urgent = intentHasAction(it);
    if (!urgent && this.sendAccumulator < 1 / NET.INPUT_RATE) return;
    this.sendAccumulator = 0;
    const seq = ++this.seq;
    const packet = { seq, mx: r(it.mx), mz: r(it.mz), sp: it.sp, ax: r(it.ax), az: r(it.az), ap: r(it.ap), sl: it.sl, tc: it.tc, ix: r(it.ix), iz: r(it.iz) };
    for (const k of ['cs', 'cr', 'kh', 'tk', 'jk', 'cy', 'nr', 'gr', 'gs']) if (it[k]) packet[k] = true;
    if (it.jk) { packet.js = it.js; packet.jt = it.jt; }
    this.net.sendInput(packet);
    const me = this.human;
    if (me) { this.history.push({ seq, x: me.position.x, z: me.position.z }); if (this.history.length > 120) this.history.shift(); }
  }

  applyReplicated(a, b, k, skip, extrap) {
    const bMap = b ? new Map(b.pl.map((e) => [e[0], e])) : null;
    for (const ea of a.pl) {
      const p = this.byId.get(ea[0]);
      if (!p) continue;
      p.active = !!(ea[10] & 4);
      p.model.root.visible = p.active;
      if (p === skip) continue;
      const eb = bMap ? bMap.get(ea[0]) : null;
      let x, z, yaw, vx, vz;
      if (eb) {
        x = ea[1] + (eb[1] - ea[1]) * k; z = ea[2] + (eb[2] - ea[2]) * k;
        let dy = eb[3] - ea[3]; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
        yaw = ea[3] + dy * k; vx = ea[4] + (eb[4] - ea[4]) * k; vz = ea[5] + (eb[5] - ea[5]) * k;
      } else {
        const ex = Math.min(extrap, 0.15);
        x = ea[1] + ea[4] * ex; z = ea[2] + ea[5] * ex; yaw = ea[3]; vx = ea[4]; vz = ea[5];
      }
      p.position.set(x, 0, z);
      p.velocity.set(vx, 0, vz);
      p.facing = yaw;
      p.facingDir.set(Math.sin(yaw), 0, Math.cos(yaw));
      p.speed = Math.hypot(vx, vz);
      p.hasBall = !!(ea[10] & 1);
      p.evadeActive = !!(ea[10] & 8);
      p.locked = !!(ea[10] & 16);
      const st = STATE_CODES[ea[6]];
      if (p.sm.state !== st) p.sm.state = st;
      this.playServerAction(p, ea, false);
      // locomotion + direction-aware blending as in Player.update
      let forwardFactor = 1, strafe = 0;
      if (p.speed > 0.3) { forwardFactor = (vx * p.facingDir.x + vz * p.facingDir.z) / p.speed; strafe = (vx * p.facingDir.z - vz * p.facingDir.x) / p.speed; }
      p.anim.setLocomotion({ speed: p.speed, sprinting: p.speed > 7, hasBall: p.hasBall, isKeeper: p.isGoalkeeper && st !== S.CELEBRATING, forwardFactor, strafe });
      p.anim.update(this.lastDt || 1 / 60);
      p.model.root.position.copy(p.position);
      p.model.root.rotation.y = yaw;
    }
  }

  /** Start the one-shot animation the server reports, once per action id. */
  playServerAction(p, e, force) {
    const id = e[7], name = ACTION_CODES[e[8]], t = e[9], dur = e[11];
    if (!id || !name) return;
    const last = this.remoteAction.get(p) || 0;
    if (id <= last && !force) return;
    this.remoteAction.set(p, id);
    // Our own predicted action may already be running: don't restart it.
    if (p === this.human && p.anim.lastAction && p.anim.lastAction.name === name && p.anim.actionTime >= 0 && p.anim.actionTime < 0.6 && !force) return;
    p.anim.playAction(name, { fade: 0.08, duration: dur || undefined, startAt: clamp(t, 0, 5) });
  }

  applyBall(a, b, k, extrap) {
    const ba = a.b, bb = b ? b.b : null;
    const ball = this.ball;
    if (bb) {
      ball.position.set(ba[0] + (bb[0] - ba[0]) * k, ba[1] + (bb[1] - ba[1]) * k, ba[2] + (bb[2] - ba[2]) * k);
      ball.velocity.set(ba[3] + (bb[3] - ba[3]) * k, ba[4] + (bb[4] - ba[4]) * k, ba[5] + (bb[5] - ba[5]) * k);
      qa.set(ba[8], ba[9], ba[10], ba[11]); qb.set(bb[8], bb[9], bb[10], bb[11]);
      ball.mesh.quaternion.copy(qa.slerp(qb, k));
    } else {
      const ex = Math.min(extrap, 0.15);
      ball.position.set(ba[0] + ba[3] * ex, Math.max(ball.radius, ba[1] + ba[4] * ex), ba[2] + ba[5] * ex);
      ball.velocity.set(ba[3], ba[4], ba[5]);
      ball.mesh.quaternion.set(ba[8], ba[9], ba[10], ba[11]);
    }
    ball.owner = ba[6] >= 0 ? this.byId.get(ba[6]) || null : null;
    ball.state = BALL_STATE_CODES[ba[7]] || BALL_STATE.FREE;
    const h = ball.position.y - ball.radius;
    const s = 0.38 + h * 0.12;
    ball.shadow.scale.set(s, s, 1);
    ball.shadow.position.y = -ball.position.y + 0.015;
    ball.shadow.material.opacity = Math.max(0.08, 0.5 - h * 0.08);
  }

  setOpponentStatus(status) { this.opponentStatus = status; }

  dispose() {
    for (const off of this.netSubs) off();
    for (const off of this.subs) off();
    this.teamManager.dispose();
    this.scene.remove(this.ball.group);
    this.audio.stopAmbience('crowd');
  }
}

const r = (v) => Math.round(v * 1000) / 1000;
