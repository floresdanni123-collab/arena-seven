import { STATE_CODES, BALL_STATE_CODES, ACTION_CODES, CONTROL_MODES, codeOf } from '../src/net/Protocol.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Compact snapshot of everything a client needs to render the match. Sent at NET.SNAPSHOT_RATE.
 *
 * pl entries: [id, x, z, yaw, vx, vz, stateCode, actionId, actionCode, actionT, flags, actionDur]
 *   flags bit0 hasBall, bit1 isHuman, bit2 active, bit3 evadeActive, bit4 locked
 * b: [x, y, z, vx, vy, vz, ownerId, stateCode, qx, qy, qz, qw]
 */
export function buildSnapshot(match, tick, serverTime) {
  const pl = [];
  for (const p of match.teamManager.allPlayers) {
    const act = p.anim.backend.currentAction;
    const last = p.anim.lastAction;
    const flags = (p.hasBall ? 1 : 0) | (p.isHuman ? 2 : 0) | (p.active ? 4 : 0) | (p.evadeActive ? 8 : 0) | (p.locked ? 16 : 0);
    pl.push([
      p.id, r2(p.position.x), r2(p.position.z), r3(p.facing), r2(p.velocity.x), r2(p.velocity.z),
      codeOf(STATE_CODES, p.sm.state),
      act && last ? last.id : 0, act && last ? codeOf(ACTION_CODES, last.name) : 0, act ? r2(act.t ?? 0) : 0,
      flags, act && last && last.duration ? r2(last.duration) : 0
    ]);
  }
  const b = match.ball;
  const q = b.mesh.quaternion;
  const sp = match.setPieces.current;
  return {
    t: 'snap', k: tick, st: serverTime, mt: r3(match.time), ms: match.state, clk: r2(match.clock), sc: [match.score[0], match.score[1]],
    ctl: [match.humans[0] ? match.humans[0].id : -1, match.humans[1] ? match.humans[1].id : -1],
    md: [codeOf(CONTROL_MODES, activeMode(match, 0)), codeOf(CONTROL_MODES, activeMode(match, 1))],
    sp: sp ? { ty: sp.type, tm: sp.team, tk: sp.taker ? sp.taker.id : -1, ph: sp.phase, x: r2(sp.position.x), z: r2(sp.position.z), so: !!sp.shootout } : null,
    seq: [match.inboxes[0].lastSeq, match.inboxes[1].lastSeq],
    poss: r3(match.possession.possessionShare()),
    rp: match.replays.isPlaying ? 1 : 0,
    pl,
    b: [r2(b.position.x), r2(b.position.y), r2(b.position.z), r2(b.velocity.x), r2(b.velocity.y), r2(b.velocity.z), b.owner ? b.owner.id : -1, codeOf(BALL_STATE_CODES, b.state), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]
  };
}

function activeMode(match, team) {
  const slot = match.slots[team];
  return slot ? slot.activeController.mode : 'normal';
}

/** Serialise gameplay event payloads: player refs become small descriptors, vectors become arrays. */
export function serializeEvent(data, depth = 0) {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (depth > 3) return undefined;
  if (data.isVector3) return [r2(data.x), r2(data.y), r2(data.z)];
  if (data.sm && data.model !== undefined) return { $p: data.id, name: data.name, number: data.number, team: data.team, isHuman: data.isHuman, isGoalkeeper: data.isGoalkeeper };
  if (Array.isArray(data)) return data.map((v) => serializeEvent(v, depth + 1));
  const out = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (typeof v === 'function') continue;
    if (k === 'players' || k === 'goal' || k === 'human') continue;
    const s = serializeEvent(v, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}
