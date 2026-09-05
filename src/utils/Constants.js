// Global tuning constants. Coordinate system:
//   X = across the pitch (width), Z = along the pitch (length), Y = up.
//   BLUE defends the goal at -Z and attacks +Z. RED defends +Z and attacks -Z.

export const PITCH = {
  LENGTH: 64,
  WIDTH: 42,
  HALF_LENGTH: 32,
  HALF_WIDTH: 21,
  GOAL_WIDTH: 6.4,
  GOAL_HEIGHT: 2.3,
  GOAL_DEPTH: 2.0,
  POST_RADIUS: 0.07,
  PENALTY_AREA_WIDTH: 22,
  PENALTY_AREA_DEPTH: 10,
  GOAL_AREA_WIDTH: 11,
  GOAL_AREA_DEPTH: 4.2,
  CENTER_CIRCLE_RADIUS: 6,
  PENALTY_SPOT: 8,
  LINE_WIDTH: 0.12,
  BOARD_MARGIN: 3.0,   // arcade rebound boards sit this far outside the lines
  BOARD_HEIGHT: 1.15,
  BOARD_RESTITUTION: 0.55
};

export const BALL = {
  RADIUS: 0.15,
  MASS: 0.43,
  GRAVITY: 9.81,
  RESTITUTION: 0.6,
  ROLL_DECEL: 2.6,        // m/s^2 rolling resistance on grass
  GROUND_FRICTION: 0.55,  // tangential velocity loss factor on bounce
  AIR_DRAG: 0.006,        // quadratic drag coefficient (v^2)
  MAGNUS: 0.0018,
  SPIN_DECAY: 0.6,
  MAX_SPEED: 42,
  SLEEP_SPEED: 0.08,
  POST_RESTITUTION: 0.7,
  PLAYER_RESTITUTION: 0.35
};

export const PLAYER = {
  RADIUS: 0.36,
  HEIGHT: 1.8,
  WALK_SPEED: 2.4,
  RUN_SPEED: 6.3,
  SPRINT_SPEED: 8.7,
  DRIBBLE_MULT: 0.94,
  ACCEL: 30,
  DECEL: 26,
  TURN_RATE: 11,          // rad/s facing interpolation
  SEPARATION: 0.9         // soft push apart distance between players
};

export const CONTROL = {
  RADIUS: 1.05,            // ball must be within this to be taken under control
  CAPTURE_MAX_SPEED: 13,   // relative ball speed that can still be trapped
  OFFSET_WALK: 0.5,
  OFFSET_RUN: 0.62,
  OFFSET_SPRINT: 0.95,
  SPRING: 22,              // ball follows the control point with this spring stiffness
  DAMPING: 8,
  LOSE_DISTANCE: 1.9,      // ball beyond this from control point -> possession lost
  KICK_IMMUNITY: 0.32,     // seconds after a kick the kicker cannot re-trap
  TURN_WIDEN: 0.55         // sharp turns push the ball wider
};

export const TACKLE = {
  COOLDOWN: 10,
  DURATION: 0.78,
  ACTIVE_START: 0.06,
  ACTIVE_END: 0.55,
  LUNGE_SPEED: 10.5,
  REACH: 1.35,             // capsule length ahead of the tackler
  RADIUS: 0.62,            // capsule radius
  RECOVER_HIT: 0.45,
  RECOVER_MISS: 0.95,
  KNOCK_SPEED: 7.5,
  VICTIM_STUN: 1.25
};

export const JUKE = {
  COOLDOWN: 10,
  DURATION: 0.58,
  EVADE_WINDOW: 0.3,
  SIDESTEP_SPEED: 7.5,
  FORWARD_BOOST: 3.0
};

export const KICK = {
  LOW_MAX_CHARGE: 1.1,
  LOW_MIN_SPEED: 6.5,
  LOW_MAX_SPEED: 26,
  LOW_MAX_LIFT: 1.6,
  HARD_SPEED: 30,
  HARD_MIN_LIFT: 3.5,
  HARD_MAX_LIFT: 11,
  HARD_INACCURACY: 0.07,   // radians of random yaw error
  LOW_INACCURACY: 0.02,
  WINDUP: 0.1,             // seconds before ball contact in the kick animation
  DURATION: 0.5,           // total kick animation lock
  PASS_ASSIST_CONE: 0.42,  // radians: teammates inside this cone are pass targets
  PASS_ASSIST_MAX_BEND: 0.16,
  REACH: 1.35              // ball must be within this to be kickable
};

export const GOALKEEPER = {
  REACTION_MIN: 0.14,
  REACTION_MAX: 0.32,
  DIVE_DURATION: 0.9,
  DIVE_REACH: 2.6,
  CATCH_MAX_SPEED: 16,
  RUSH_DISTANCE: 9,
  HOLD_TIME: 1.4,
  THROW_SPEED: 13,
  KICK_SPEED: 27,
  BASE_DEPTH: 1.4,         // distance in front of goal line when idle
  MAX_DEPTH: 6,
  SPEED: 6.0,
  SPRINT: 7.4
};

export const MATCH = {
  DURATION: 300,
  GOAL_FREEZE: 3.6,
  KICKOFF_DELAY: 1.2,
  FULLTIME_DELAY: 2.5
};

export const FOUL = {
  TOLERANCE: 0.55,          // 0..1: higher = referee lets more contact go
  BALL_NEAR: 1.6,           // ball within this of the contact point counts as "playing the ball"
  BALL_FAR: 2.6,            // beyond this the tackle is reckless
  YELLOW_SEVERITY: 0.62,
  RED_SEVERITY: 0.9,
  REPEAT_FOULS_FOR_YELLOW: 3,
  ADVANTAGE_WINDOW: 1.6,    // seconds the referee waits before deciding on advantage
  STOPPAGE_TIME: 1.4
};

export const SET_PIECE = {
  OPPONENT_DISTANCE: 7.0,   // scaled-down "9.15m"
  SETUP_TIMEOUT: 2.4,       // seconds players get to walk into position before being nudged
  AI_TAKE_DELAY_MIN: 0.8,
  AI_TAKE_DELAY_MAX: 1.6,
  PENALTY_RUNUP: 3.4,
  HUMAN_TAKE_TIMEOUT: 14,   // an idle human taker loses the restart to the AI after this many seconds
  WALL_DISTANCE_MAX: 26,    // build a wall when the free kick is closer than this
  THROW_MIN_SPEED: 7,
  THROW_MAX_SPEED: 17,
  GOAL_KICK_OFFSET: 3.0,
  CORNER_INSET: 0.4
};

export const SHIFT_LOCK = {
  SIDE_OFFSET: 1.1,          // camera sits this far to the player's right (over the shoulder)
  HEIGHT: 1.55,
  DISTANCE: 6.6,
  KEEPER_SIDE_OFFSET: 0.85,
  KEEPER_HEIGHT: 1.9,
  KEEPER_DISTANCE: 6.4,
  ROTATION_SPEED: 15,        // rad/s the player turns toward the camera's horizontal forward
  TRANSITION: 0.22           // seconds to blend the camera between normal and shift-lock framing
};

export const REPLAY = {
  BUFFER_SECONDS: 10,
  RATE: 20,                 // snapshots per second
  LEAD_IN: 4.2,             // seconds before the event
  LEAD_OUT: 0.9,
  SLOWMO: 0.42,
  MISS_MARGIN: 2.6,         // a miss inside this distance of the frame is replay-worthy
  MIN_SHOT_SPEED: 14
};

export const TOUCH = {
  PASS: 'PASS', SHOT: 'SHOT', TACKLE: 'TACKLE', BLOCK: 'BLOCK', SAVE: 'SAVE',
  DEFLECTION: 'DEFLECTION', DRIBBLE: 'DRIBBLE', KEEPER_TOUCH: 'KEEPER_TOUCH', THROW: 'THROW'
};

export const RESTART = {
  THROW_IN: 'THROW_IN', CORNER: 'CORNER', GOAL_KICK: 'GOAL_KICK', KICKOFF: 'KICKOFF', FREE_KICK: 'FREE_KICK', PENALTY: 'PENALTY'
};

export const MATCH_STATE = {
  KICKOFF: 'KICKOFF',
  PLAYING: 'PLAYING',
  GOAL: 'GOAL',
  GOAL_REPLAY: 'GOAL_REPLAY',
  GOAL_UI: 'GOAL_UI',
  SAVE_REPLAY: 'SAVE_REPLAY',
  MISSED_SHOT_REPLAY: 'MISSED_SHOT_REPLAY',
  FOUL_STOPPAGE: 'FOUL_STOPPAGE',
  FREE_KICK: 'FREE_KICK',
  PENALTY: 'PENALTY',
  THROW_IN: 'THROW_IN',
  CORNER_KICK: 'CORNER_KICK',
  GOAL_KICK: 'GOAL_KICK',
  PENALTY_SHOOTOUT: 'PENALTY_SHOOTOUT',
  FULLTIME: 'FULLTIME',
  MATCH_FINISHED: 'MATCH_FINISHED'
};

export const TEAM = { BLUE: 0, RED: 1 };
export const TEAM_NAMES = ['BLUE', 'RED'];

export const BALL_STATE = {
  FREE: 'FREE',
  CONTROLLED: 'CONTROLLED',
  DRIBBLING: 'DRIBBLING',
  KICKED: 'KICKED',
  LOOSE: 'LOOSE',
  GOALKEEPER_HELD: 'GOALKEEPER_HELD'
};

export const PLAYER_STATE = {
  IDLE: 'IDLE',
  WALKING: 'WALKING',
  RUNNING: 'RUNNING',
  SPRINTING: 'SPRINTING',
  DRIBBLING: 'DRIBBLING',
  KICKING: 'KICKING',
  TACKLING: 'TACKLING',
  JUKING: 'JUKING',
  STUNNED: 'STUNNED',
  FALLING: 'FALLING',
  RECOVERING: 'RECOVERING',
  DIVING: 'DIVING',
  HOLDING: 'HOLDING',
  THROWING: 'THROWING',
  CELEBRATING: 'CELEBRATING'
};

export const ROLE = {
  GOALKEEPER: 'GK',
  DEFENDER: 'DEF',
  MIDFIELDER: 'MID',
  ATTACKER: 'ATT'
};

export const AI_DIFFICULTY = {
  EASY:   { reaction: 0.45, accuracy: 0.6, tackleAggression: 0.35, passVision: 0.5, speedMult: 0.9,  gkReactionMult: 1.4, gkReach: 0.8, shootRange: 17, markingTightness: 0.5 },
  NORMAL: { reaction: 0.25, accuracy: 0.78, tackleAggression: 0.6, passVision: 0.75, speedMult: 0.97, gkReactionMult: 1.0, gkReach: 1.0, shootRange: 21, markingTightness: 0.7 },
  HARD:   { reaction: 0.12, accuracy: 0.9, tackleAggression: 0.85, passVision: 0.92, speedMult: 1.02, gkReactionMult: 0.75, gkReach: 1.12, shootRange: 24, markingTightness: 0.9 }
};

export const COLORS = {
  BLUE_SHIRT: 0x1f5fe6,
  BLUE_SHORTS: 0xf5f7ff,
  BLUE_GK: 0xf2c20a,
  RED_SHIRT: 0xe0242f,
  RED_SHORTS: 0x1b1b24,
  RED_GK: 0x25c46b,
  SOCKS_BLUE: 0x1f5fe6,
  SOCKS_RED: 0xe0242f
};

export const KIT_SWATCHES = [0x1f5fe6, 0xe0242f, 0xf2c20a, 0x25c46b, 0xffffff, 0x1b1b24, 0xff7a1f, 0x8a2be2, 0x00c2d6, 0xff3fa4];
