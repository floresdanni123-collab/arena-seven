import * as THREE from 'three';
import { TACKLE, PLAYER_STATE as S, TEAM_NAMES } from '../utils/Constants.js';

const MAX_SEGMENTS = 2000;

/**
 * Optional debug overlay (F3): AI targets, formation anchors, ball velocity, possession owner,
 * goalkeeper shot prediction, tackle hitboxes and a text panel with player/ball states.
 */
export class DebugRenderer {
  constructor(scene, uiRoot) {
    this.scene = scene;
    this.enabled = false;
    this.positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
    this.colors = new Float32Array(MAX_SEGMENTS * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
    this.count = 0;
    this.panel = document.createElement('div');
    this.panel.className = 'debug-panel hidden';
    uiRoot.appendChild(this.panel);
    this.color = new THREE.Color();
  }

  setEnabled(v) {
    this.enabled = v;
    this.lines.visible = v;
    this.panel.classList.toggle('hidden', !v);
  }

  seg(ax, ay, az, bx, by, bz, hex) {
    if (this.count >= MAX_SEGMENTS) return;
    const i = this.count * 6;
    const p = this.positions, c = this.colors;
    p[i] = ax; p[i + 1] = ay; p[i + 2] = az; p[i + 3] = bx; p[i + 4] = by; p[i + 5] = bz;
    this.color.setHex(hex);
    c[i] = c[i + 3] = this.color.r; c[i + 1] = c[i + 4] = this.color.g; c[i + 2] = c[i + 5] = this.color.b;
    this.count++;
  }

  cross(x, z, size, hex, y = 0.05) {
    this.seg(x - size, y, z, x + size, y, z, hex);
    this.seg(x, y, z - size, x, y, z + size, hex);
  }

  circle(x, z, r, hex, y = 0.05, n = 16) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      this.seg(x + Math.cos(a) * r, y, z + Math.sin(a) * r, x + Math.cos(b) * r, y, z + Math.sin(b) * r, hex);
    }
  }

  update(match) {
    if (!this.enabled || !match) return;
    this.count = 0;
    const ball = match.ball;
    for (const p of match.players) {
      const teamHex = p.team === 0 ? 0x4da3ff : 0xff6b6b;
      // AI target
      if (!p.isHuman) this.seg(p.position.x, 0.1, p.position.z, p.targetPosition.x, 0.1, p.targetPosition.z, 0x00e5ff);
      // formation anchor
      this.cross(p.homePosition.x, p.homePosition.z, 0.4, 0xffe14d);
      this.seg(p.homePosition.x, 0.05, p.homePosition.z, p.position.x, 0.05, p.position.z, 0x554400);
      // marker for mark targets
      if (p.ai && p.ai.teamAI) {
        const a = p.ai.teamAI.getAssignment(p);
        if (a && a.markTarget) this.seg(p.position.x, 0.6, p.position.z, a.markTarget.position.x, 0.6, a.markTarget.position.z, 0xff9900);
      }
      // tackle capsule
      if (p.sm.is(S.TACKLING) && p.tackle) {
        const d = p.tackle.dir;
        const ex = p.position.x + d.x * TACKLE.REACH, ez = p.position.z + d.z * TACKLE.REACH;
        this.circle(p.position.x, p.position.z, TACKLE.RADIUS, 0xff2040, 0.25);
        this.circle(ex, ez, TACKLE.RADIUS, 0xff2040, 0.25);
        const lx = -d.z * TACKLE.RADIUS, lz = d.x * TACKLE.RADIUS;
        this.seg(p.position.x + lx, 0.25, p.position.z + lz, ex + lx, 0.25, ez + lz, 0xff2040);
        this.seg(p.position.x - lx, 0.25, p.position.z - lz, ex - lx, 0.25, ez - lz, 0xff2040);
      }
      // evade window
      if (p.evadeActive) this.circle(p.position.x, p.position.z, 0.7, 0xb8ff3b, 0.3, 12);
      // facing
      this.seg(p.position.x, 1.0, p.position.z, p.position.x + p.facingDir.x, 1.0, p.position.z + p.facingDir.z, teamHex);
      // goalkeeper prediction
      if (p.isGoalkeeper && p.ai && p.ai.threat) {
        const pr = p.ai.debugPrediction;
        this.cross(pr.x, pr.z, 0.5, 0x00ff88, pr.y);
        this.seg(ball.position.x, ball.position.y, ball.position.z, pr.x, pr.y, pr.z, 0x00ff88);
      }
    }
    // ball velocity + owner
    this.seg(ball.position.x, ball.position.y, ball.position.z, ball.position.x + ball.velocity.x * 0.5, ball.position.y + ball.velocity.y * 0.5, ball.position.z + ball.velocity.z * 0.5, 0xff40ff);
    if (ball.owner) this.circle(ball.owner.position.x, ball.owner.position.z, 1.05, 0xffffff, 0.08, 20);

    this.lines.geometry.setDrawRange(0, this.count * 2);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;

    // panel
    const lines = [];
    lines.push(`MATCH ${match.state}  clock ${match.clock.toFixed(1)}  score ${match.score[0]}-${match.score[1]}`);
    lines.push(`BALL ${ball.state} spd ${ball.speed.toFixed(1)} y ${ball.position.y.toFixed(2)} owner ${ball.owner ? ball.owner.name : '-'}`);
    if (match.online) {
      const n = match.net;
      lines.push(`NET room ${match.descriptor.roomId} me ${n.identity ? n.identity.playerId : '-'} team ${match.localTeam}`);
      lines.push(`NET ping ${n.ping}ms tick ${match.stats.serverTick} snaps/s ${n.stats.snapshotRate} pkts ${n.stats.received} ack ${match.lastAck} buf ${match.buffer.length}`);
      lines.push(`NET controlled ${match.human ? match.human.name : '-'} predicting ${match.isPredicting()} corr ${match.correction.length().toFixed(2)}`);
    } else {
      lines.push(`phase B:${match.teamManager.teamAIs[0].phase} R:${match.teamManager.teamAIs[1].phase}`);
    }
    lines.push('');
    for (const p of match.players) {
      const a = p.ai && p.ai.teamAI ? p.ai.teamAI.getAssignment(p) : null;
      const task = p.isHuman ? 'HUMAN' : p.isGoalkeeper ? (p.ai.mode || 'GK') : (a ? a.task : '-');
      lines.push(`${TEAM_NAMES[p.team][0]}${String(p.number).padStart(2)} ${p.role.padEnd(3)} ${p.sm.state.padEnd(11)} ${task.padEnd(8)} v${p.speed.toFixed(1)}${p.evadeActive ? ' EVADE' : ''}${p.hasBall ? ' BALL' : ''}`);
    }
    this.panel.textContent = lines.join('\n');
  }

  dispose() {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.panel.remove();
  }
}
