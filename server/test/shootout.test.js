/**
 * Headless rules check for online matches: a tied match goes to a shootout, and during each penalty
 * the shooting team's human takes it while the other team's human is moved onto their goalkeeper.
 * Also verifies an idle human taker loses a restart to the AI instead of freezing the match.
 * Run with: node server/test/shootout.test.js
 */
import { createHeadlessMatch } from '../HeadlessMatch.js';
import { MATCH_STATE, TEAM } from '../../src/utils/Constants.js';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const step = (match, n) => { for (let i = 0; i < n; i++) match.update(1 / 60); };

const { match, events } = createHeadlessMatch({ humanNames: { 0: 'Blue Human', 1: 'Red Human' }, duration: 8 });
check(match.humans[0] && match.humans[1] && match.humans[0].team === 0 && match.humans[1].team === 1, 'two human slots exist, one per team');
step(match, 300);
check(match.state === MATCH_STATE.PLAYING, 'kick-off leads to PLAYING');

// Idle human restart timeout: award BLUE a free kick and wait.
const V3 = match.ball.position.constructor;
match.onFoulAwarded({ type: 'FREE_KICK', team: 0, position: new V3(-4, 0, 10), verdict: { reason: 'PLAYER_FIRST', card: null } });
let frames = 0; while (!match.setPieces.isActive() && frames++ < 400) step(match, 1);
check(match.setPieces.isActive() && match.setPieces.taker === match.humans[0], 'BLUE human is the free-kick taker');
frames = 0; while (match.setPieces.isActive() && frames++ < 60 * 25) step(match, 1);
check(!match.setPieces.isActive() && match.state === MATCH_STATE.PLAYING, `idle human restart was taken automatically (${(frames / 60).toFixed(1)}s)`);

// Force a tied full time.
match.score[0] = 1; match.score[1] = 1;
match.clock = match.duration - 0.1;
frames = 0; while (match.state !== MATCH_STATE.PENALTY_SHOOTOUT && frames++ < 600) step(match, 1);
check(match.state === MATCH_STATE.PENALTY_SHOOTOUT, 'tied match enters the penalty shootout');

const roles = [];
let kicks = 0;
events.on('shootout_kick', () => kicks++);
for (let k = 0; k < 6 && match.shootout.active; k++) {
  frames = 0; while (!(match.setPieces.phase === 'READY' && match.setPieces.taker) && match.shootout.active && frames++ < 900) step(match, 1);
  if (!match.shootout.active) break;
  const taker = match.setPieces.taker;
  const shooting = taker.team, defending = 1 - shooting;
  roles.push({ shooting, takerIsHuman: match.humans[shooting] === taker, defenderHumanIsGK: match.humans[defending].isGoalkeeper });
  // Human shooter: the intent path would deliver a shot; simulate it directly.
  match.setPieces.requestPenaltyShot({ type: 'hard', power: 1, dir: new V3(0.1, 0, shooting === 0 ? 1 : -1).normalize(), lift: 1.4 });
  const before = match.shootout.kickIndex;
  frames = 0; while (match.shootout.kickIndex === before && match.shootout.active && frames++ < 900) step(match, 1);
}
check(roles.length >= 4, `at least four penalties were taken (${roles.length})`);
check(roles.every((r) => r.takerIsHuman), 'the shooting team\'s human always takes the penalty');
check(roles.every((r) => r.defenderHumanIsGK), 'the defending team\'s human is always on their goalkeeper');
check(roles.some((r) => r.shooting === TEAM.BLUE) && roles.some((r) => r.shooting === TEAM.RED), 'both teams shoot');
check(kicks === roles.length, `every penalty was recorded (${kicks})`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll shootout checks passed');
process.exit(failures ? 1 : 0);
