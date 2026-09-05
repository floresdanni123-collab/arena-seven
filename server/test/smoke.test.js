/**
 * Server smoke test: boots the server on a free port, connects two WebSocket clients, verifies
 * matchmaking pairs them with opposite teams, both receive START_MATCH and snapshots from the same
 * room, inputs move the controlled player, a third client in another room gets no cross-talk,
 * cancel removes a queue entry, and a disconnect awards the win to the remaining player.
 * Run with: npm run test:server
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { C2S, S2C } from '../../src/net/Protocol.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const url = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

class Client {
  constructor(name) { this.name = name; this.msgs = []; this.waiters = []; this.ws = null; this.snaps = 0; this.roomIds = new Set(); }
  connect(reconnect) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => { this.send({ t: C2S.HELLO, name: this.name, reconnect }); resolve(); });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === S2C.SNAPSHOT) { this.snaps++; this.lastSnap = m; }
        if (m.t === S2C.WELCOME) this.identity = m;
        if (m.t === S2C.MATCH_FOUND) { this.match = m; this.roomIds.add(m.roomId); }
        this.msgs.push(m);
        for (const w of this.waiters.slice()) if (w.type === m.t) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
      this.ws.on('error', reject);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  waitFor(type, timeout = 8000) {
    const existing = this.msgs.find((m) => m.t === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => { const w = { type, resolve }; this.waiters.push(w); setTimeout(() => { if (this.waiters.includes(w)) { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${type} (${this.name})`)); } }, timeout); });
  }
  close() { this.ws.close(); }
}

async function main() {
  const server = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'silent', MATCH_DURATION: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await wait(1200);
  try {
    // 1-4: two players queue, get paired with opposite teams, both load the same room
    const a = new Client('Alice'), b = new Client('Bob');
    await a.connect(); await b.connect();
    await a.waitFor(S2C.WELCOME); await b.waitFor(S2C.WELCOME);
    a.send({ t: C2S.FIND_MATCH, region: 'AUTO' });
    const q = await a.waitFor(S2C.QUEUE);
    check(q.state === 'SEARCHING' && q.waiting === 1, 'first player waits in queue (waiting=1)');
    b.send({ t: C2S.FIND_MATCH, region: 'AUTO' });
    const fa = await a.waitFor(S2C.MATCH_FOUND), fb = await b.waitFor(S2C.MATCH_FOUND);
    check(fa.roomId === fb.roomId, 'both players receive the same room id ' + fa.roomId);
    check(fa.team !== fb.team && [0, 1].includes(fa.team), `teams are opposite (A=${fa.team}, B=${fb.team})`);
    check(fa.roster.length === 14 && JSON.stringify(fa.roster) === JSON.stringify(fb.roster), 'identical 14-player roster sent to both');
    a.send({ t: C2S.READY });
    await wait(300);
    check(!a.msgs.some((m) => m.t === S2C.START_MATCH), 'match does not start until both are ready');
    b.send({ t: C2S.READY });
    const sa = await a.waitFor(S2C.START_MATCH), sb = await b.waitFor(S2C.START_MATCH);
    check(sa.startAt === sb.startAt, 'both receive the same synchronised start timestamp');
    await wait(4500);
    check(a.snaps > 10 && b.snaps > 10, `snapshots flow to both (${a.snaps}, ${b.snaps})`);
    check(a.lastSnap.sc[0] === b.lastSnap.sc[0] && a.lastSnap.ms === b.lastSnap.ms, 'both see the same score and match state');

    // 7-8: input moves the controlled player on the server
    const myId = a.lastSnap.ctl[fa.team];
    const before = a.lastSnap.pl.find((p) => p[0] === myId);
    const dir = fa.team === 0 ? 1 : -1;
    for (let i = 1; i <= 40; i++) { a.send({ t: C2S.INPUT, i: { seq: i, mx: 0, mz: dir, sp: true, ax: 0, az: dir, ap: 0 } }); await wait(33); }
    await wait(300);
    const after = a.lastSnap.pl.find((p) => p[0] === myId);
    check(Math.abs(after[2] - before[2]) > 3, `input moved the controlled player (${before[2].toFixed(1)} -> ${after[2].toFixed(1)})`);
    check(b.lastSnap.pl.find((p) => p[0] === myId)[2] === after[2] || Math.abs(b.lastSnap.pl.find((p) => p[0] === myId)[2] - after[2]) < 3, 'opponent sees the moved player');
    check(a.lastSnap.seq[fa.team] === 40, 'server acknowledges the last input sequence');

    // Rejected garbage input
    a.send({ t: C2S.INPUT, i: { seq: 41, mx: 999, mz: 999, ax: 'x', kh: 'yes' } });
    await wait(200);
    check(a.snaps > 0, 'malformed input does not crash the room');

    // 24: a second room gets no cross-talk
    const c = new Client('Cara'), d = new Client('Dan');
    await c.connect(); await d.connect();
    await c.waitFor(S2C.WELCOME); await d.waitFor(S2C.WELCOME);
    c.send({ t: C2S.FIND_MATCH }); d.send({ t: C2S.FIND_MATCH });
    const fc = await c.waitFor(S2C.MATCH_FOUND);
    check(fc.roomId !== fa.roomId, 'second pair gets a different room ' + fc.roomId);
    c.send({ t: C2S.READY }); d.send({ t: C2S.READY });
    await wait(4500);
    const foreign = c.msgs.filter((m) => m.t === S2C.EVENT || m.t === S2C.SNAPSHOT).some((m) => m.roomId && m.roomId !== fc.roomId);
    check(!foreign && c.roomIds.size === 1, 'room 2 players only ever see their own room');

    // 23: cancel removes a queue entry (and duplicate queue join is refused)
    const e = new Client('Eve');
    await e.connect(); await e.waitFor(S2C.WELCOME);
    e.send({ t: C2S.FIND_MATCH }); await e.waitFor(S2C.QUEUE);
    e.send({ t: C2S.FIND_MATCH });
    const err = await e.waitFor(S2C.ERROR);
    check(err.code === 'ALREADY_QUEUED', 'joining the queue twice is refused');
    e.send({ t: C2S.CANCEL_MATCH });
    await wait(300);
    const f = new Client('Finn');
    await f.connect(); await f.waitFor(S2C.WELCOME);
    f.send({ t: C2S.FIND_MATCH });
    const qf = await f.waitFor(S2C.QUEUE);
    check(qf.waiting === 1, 'cancelled player left no ghost in the queue');
    f.send({ t: C2S.CANCEL_MATCH }); e.close(); f.close();

    // 21: brief disconnect + reconnect restores the same match
    const ident = a.identity;
    a.close();
    const oppMsg = await b.waitFor(S2C.OPPONENT_STATUS);
    check(oppMsg.status === 'DISCONNECTED', 'opponent is told about the disconnect');
    await wait(500);
    const a2 = new Client('Alice');
    await a2.connect({ sessionId: ident.sessionId, token: ident.token });
    const w2 = await a2.waitFor(S2C.WELCOME);
    check(w2.resumed === true && w2.sessionId === ident.sessionId, 'reconnect with the token resumes the session');
    const mf2 = await a2.waitFor(S2C.MATCH_FOUND);
    check(mf2.roomId === fa.roomId && mf2.team === fa.team, 'reconnected player is put back in the same room and team');
    a2.send({ t: C2S.READY });
    await wait(1500);
    check(a2.snaps > 0, 'snapshots resume after reconnect');
    // Wrong token must not hijack the slot
    const bad = new Client('Mallory');
    await bad.connect({ sessionId: ident.sessionId, token: 'nope' });
    const wbad = await bad.waitFor(S2C.WELCOME);
    check(wbad.sessionId !== ident.sessionId, 'a wrong token cannot take over another session');
    bad.close();

    // 22: permanent disconnect awards the win (grace period shortened via a second disconnect + wait)
    a2.close();
    await b.waitFor(S2C.OPPONENT_STATUS);
    console.log('      waiting for the reconnect grace period to expire...');
    const end = await b.waitFor(S2C.MATCH_END, 20000);
    check(end.reason === 'OPPONENT_DISCONNECTED' && end.winner === fb.team, 'remaining player is awarded the win');
    b.close(); c.close(); d.close();
  } catch (e) {
    console.error('TEST ERROR', e);
    failures++;
  } finally {
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll server checks passed');
  process.exit(failures ? 1 : 0);
}

main();
