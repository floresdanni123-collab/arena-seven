/**
 * Shared client/server protocol. Plain JSON messages of the form { t: TYPE, ...payload }.
 * Imported by both the Vite client (src/) and the Node server (server/).
 */
export const NET = {
  TICK_RATE: 60,          // server simulation steps per second
  SNAPSHOT_RATE: 20,      // snapshots per second sent to clients
  INPUT_RATE: 30,         // client intent packets per second (plus immediate sends on actions)
  INTERP_DELAY: 0.1,      // seconds remote entities are rendered behind server time
  RECONNECT_GRACE: 15,    // seconds a disconnected player keeps their slot
  PING_INTERVAL: 2,       // seconds between ping probes
  MAX_INPUT_AGE: 2        // ignore intents older than this (seconds of server time)
};

/** Messages from client to server. */
export const C2S = {
  HELLO: 'hello',             // { name?, reconnect?: { sessionId, token } }
  FIND_MATCH: 'find_match',   // { region: 'AUTO' }
  CANCEL_MATCH: 'cancel_match',
  READY: 'ready',             // client finished loading the match
  INPUT: 'input',             // { i: intent }
  PING: 'ping',               // { c: clientTime }
  REMATCH: 'rematch',         // { accept: bool }
  LEAVE: 'leave'
};

/** Messages from server to client. */
export const S2C = {
  WELCOME: 'welcome',         // { playerId, sessionId, token, displayName, resumed?: bool }
  QUEUE: 'queue',             // { state, waiting, elapsed }
  MATCH_FOUND: 'match_found', // { roomId, team, opponent: { name }, roster }
  START_MATCH: 'start_match', // { startAt (server ms), matchStartTime }
  SNAPSHOT: 'snap',           // compact match snapshot
  EVENT: 'event',             // { name, data } gameplay event relayed from the room
  MATCH_STATE: 'match_state', // { state, ... } authoritative phase changes
  OPPONENT_STATUS: 'opp',     // { status: 'DISCONNECTED' | 'RECONNECTED' | 'LEFT', grace }
  MATCH_END: 'match_end',     // { reason, winner, score, shootout }
  REMATCH: 'rematch',         // { requestedBy, accepted, declined }
  PONG: 'pong',               // { c, s }
  ERROR: 'error'              // { code, message }
};

/** Client-side connection / matchmaking states. */
export const CONN_STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  SEARCHING: 'SEARCHING',
  MATCH_FOUND: 'MATCH_FOUND',
  LOADING_MATCH: 'LOADING_MATCH',
  IN_MATCH: 'IN_MATCH',
  RECONNECTING: 'RECONNECTING',
  MATCH_FINISHED: 'MATCH_FINISHED'
};

/** Server-side per-session queue states. */
export const QUEUE_STATE = { IDLE: 'IDLE', QUEUED: 'QUEUED', MATCHED: 'MATCHED', IN_GAME: 'IN_GAME' };

/** Player state machine names encoded as small integers for snapshots. */
export const STATE_CODES = ['IDLE', 'WALKING', 'RUNNING', 'SPRINTING', 'DRIBBLING', 'KICKING', 'TACKLING', 'JUKING', 'STUNNED', 'FALLING', 'RECOVERING', 'DIVING', 'HOLDING', 'THROWING', 'CELEBRATING'];
export const BALL_STATE_CODES = ['FREE', 'CONTROLLED', 'DRIBBLING', 'KICKED', 'LOOSE', 'GOALKEEPER_HELD'];
export const ACTION_CODES = ['', 'lowKick', 'hardKick', 'gkKick', 'slideTackle', 'jukeLeft', 'jukeRight', 'fall', 'recover', 'celebrate', 'gkDiveLeft', 'gkDiveRight', 'gkCatch', 'gkParry', 'gkPickup', 'gkThrow'];
export const CONTROL_MODES = ['normal', 'setpiece', 'throwin', 'penalty', 'hold'];

export const codeOf = (list, v) => { const i = list.indexOf(v); return i < 0 ? 0 : i; };

/** Validation limits applied by the server to client intents. */
export const LIMITS = { MAX_INPUT_PER_SEC: 90, MAX_NAME_LENGTH: 16 };

export function encode(msg) { return JSON.stringify(msg); }
export function decode(text) { try { return JSON.parse(text); } catch (_) { return null; } }
