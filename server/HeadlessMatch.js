import * as THREE from 'three';
import { MatchManager } from '../src/match/MatchManager.js';
import { EventBus } from '../src/core/EventBus.js';
import { Goal } from '../src/world/Goal.js';
import { TEAM } from '../src/utils/Constants.js';
import { NetworkInbox, NetworkController } from './NetworkController.js';

/** Audio stand-in: the server never plays sound. */
const NullAudio = { play() {}, startAmbience() {}, setAmbienceLevel() {}, stopAmbience() {}, startMusic() {}, stopMusic() {}, randomPitch() { return 1; } };

/**
 * Builds a fully authoritative MatchManager with no rendering: no DOM, no canvases, no audio.
 * Both human slots are driven by NetworkInbox/NetworkController pairs fed from client intents.
 */
export function createHeadlessMatch({ humanNames, duration, difficulty = 'NORMAL', initialSeed } = {}) {
  const events = new EventBus();
  const scene = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
  const sceneManager = { scene, camera, focusShadows() {} };
  const arena = { goals: [new Goal(-1), new Goal(1)], stadium: { update() {} }, pitch: null };
  const inboxes = { [TEAM.BLUE]: new NetworkInbox(TEAM.BLUE), [TEAM.RED]: new NetworkInbox(TEAM.RED) };
  const controllerFactory = (team) => ({ controller: new NetworkController(inboxes[team], 'outfield'), gkController: new NetworkController(inboxes[team], 'keeper') });

  const match = new MatchManager({
    sceneManager, assets: null, settings: null, audio: NullAudio, events, input: null, arena, mode: 'match',
    humanTeams: [TEAM.BLUE, TEAM.RED], localTeam: null, headless: true, humanNames, difficulty, controllerFactory, duration
  }).start();
  match.inboxes = inboxes;
  return { match, events, inboxes };
}
