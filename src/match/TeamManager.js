import { Player } from '../player/Player.js';
import { PlayerModel } from '../player/PlayerModel.js';
import { AIPlayer } from '../ai/AIPlayer.js';
import { GoalkeeperAI } from '../ai/GoalkeeperAI.js';
import { TeamAI } from '../ai/TeamAI.js';
import { FormationSystem } from '../ai/FormationSystem.js';
import { TEAM, ROLE, COLORS, AI_DIFFICULTY } from '../utils/Constants.js';
import { pick } from '../utils/MathUtils.js';

const FIRST = ['Mateo', 'Kai', 'Luca', 'Rafa', 'Idris', 'Theo', 'Sami', 'Noah', 'Jonah', 'Ezra', 'Diego', 'Malik', 'Arlo', 'Nico', 'Yusuf', 'Leon', 'Tariq', 'Bruno', 'Emil', 'Zane'];
const LAST = ['Okafor', 'Silva', 'Haddad', 'Nakamura', 'Kovac', 'Rossi', 'Mensah', 'Berg', 'Dubois', 'Ferreira', 'Petrov', 'Alvarez', 'Yilmaz', 'Adeyemi', 'Moreau', 'Kim', 'Santos', 'Lund', 'Baptiste', 'Novak'];
const SKIN = [0xd9a37b, 0xa8734f, 0x6b4a32, 0xf1c9a5, 0x8c5a3c, 0xc48c63];
const HAIR = [0x2a1a10, 0x111111, 0x6b3b1a, 0xd9b26f, 0x3a2a20];

/**
 * Builds both squads (7 each) with kits, names, numbers, AI brains and team coordinators.
 *
 * Options:
 *   humanTeams  - which teams have a human slot (default [BLUE]; online matches use [BLUE, RED])
 *   localTeam   - which human is "ours" for camera/HUD purposes (null on the server)
 *   headless    - server mode: no models, no DOM
 *   roster      - a roster produced by another TeamManager (the server's) so clients build identical squads
 *   humanNames  - display names for human slots keyed by team
 */
export class TeamManager {
  constructor({ assets, scene, settings, formation = '2-3-1', training = false, humanTeams = [TEAM.BLUE], localTeam = TEAM.BLUE, headless = false, roster = null, humanNames = null, difficulty = null }) {
    this.assets = assets;
    this.scene = scene;
    this.settings = settings;
    this.training = training;
    this.headless = headless;
    this.humanTeams = humanTeams;
    this.localTeam = localTeam;
    this.humanNames = humanNames || {};
    this.formationName = formation;
    this.formation = new FormationSystem(formation);
    this.players = [];
    this.allPlayers = [];
    this.teams = [[], []];
    this.teamAIs = [];
    this.humans = {};
    this.human = null;
    this.roster = roster;
    const diffName = difficulty || (settings ? settings.get('difficulty') : 'NORMAL');
    this.difficulty = AI_DIFFICULTY[diffName] || AI_DIFFICULTY.NORMAL;
  }

  /** Produce the squad description (deterministic input for clients when sent by the server). */
  generateRoster() {
    const profile = this.settings ? this.settings.profile : null;
    const useProfile = !!profile && this.humanTeams.length === 1;
    const kits = [
      { shirt: useProfile ? profile.shirtColor : COLORS.BLUE_SHIRT, shorts: useProfile ? profile.shortsColor : COLORS.BLUE_SHORTS, socks: useProfile ? profile.shirtColor : COLORS.SOCKS_BLUE, gk: COLORS.BLUE_GK },
      { shirt: COLORS.RED_SHIRT, shorts: COLORS.RED_SHORTS, socks: COLORS.SOCKS_RED, gk: COLORS.RED_GK }
    ];
    if (Math.abs(kits[0].shirt - kits[1].shirt) < 0x101010) { kits[1].shirt = 0xffffff; kits[1].shorts = 0x1b1b24; kits[1].socks = 0xffffff; }
    const usedNames = new Set();
    const roster = [];
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const kit = kits[team];
      this.formation.slots.forEach((slot, slotIndex) => {
        const isGK = slot.role === ROLE.GOALKEEPER;
        const isHuman = this.humanTeams.includes(team) && slot.role === ROLE.ATTACKER;
        if (this.training && team === TEAM.RED && !isGK) return;
        let name;
        do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
        usedNames.add(name);
        const humanName = this.humanNames[team] || (useProfile && profile ? (profile.playerName || 'YOU') : 'YOU');
        roster.push({
          team, slotIndex, role: slot.role, isGK, isHuman,
          name: isHuman ? humanName : name,
          number: isGK ? 1 : (isHuman && useProfile ? profile.shirtNumber : (isHuman ? 10 : 2 + slotIndex + (team === TEAM.RED ? 7 : 0))),
          shirt: isGK ? kit.gk : kit.shirt, shorts: isGK ? 0x111111 : kit.shorts, socks: kit.socks,
          skin: isHuman && useProfile ? profile.skinTone : pick(SKIN),
          hair: isHuman && useProfile ? profile.hairColor : pick(HAIR),
          hairStyle: isHuman && useProfile ? profile.hairStyle : Math.floor(Math.random() * 4)
        });
      });
    }
    return roster;
  }

  build() {
    if (!this.roster) this.roster = this.generateRoster();
    let id = 0;
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const teamAI = new TeamAI(team, this.formation, this.difficulty);
      this.teamAIs[team] = teamAI;
      for (const r of this.roster.filter((x) => x.team === team)) {
        const model = new PlayerModel({
          assets: this.assets, goalkeeper: r.isGK, headless: this.headless,
          shirtColor: r.shirt, shortsColor: r.shorts, socksColor: r.socks,
          skinTone: r.skin, hairColor: r.hair, hairStyle: r.hairStyle, number: r.number,
          name: r.isHuman ? r.name : r.name.split(' ')[1].toUpperCase()
        });
        const player = new Player({ id: id++, team, role: r.role, name: r.name, number: r.number, model, isHuman: r.isHuman, difficulty: this.difficulty });
        player.slotIndex = r.slotIndex;
        if (this.scene) this.scene.add(model.root);
        if (r.isHuman) {
          this.humans[team] = player;
          if (team === this.localTeam) { this.human = player; model.showName(true); model.setMarker(0xb8ff3b); }
        }
        // Every player gets a brain; humans keep theirs suspended (used again when control moves away).
        player.ai = r.isGK ? new GoalkeeperAI(player, teamAI, this.difficulty) : new AIPlayer(player, teamAI, this.difficulty);
        if (r.isHuman) player.speedMult = 1;
        this.players.push(player);
        this.allPlayers.push(player);
        this.teams[team].push(player);
      }
      teamAI.setPlayers(this.teams[team]);
    }
    if (!this.human) this.human = this.humans[TEAM.BLUE] || this.players[0];
    return this;
  }

  getGoalkeeper(team) { return this.teams[team].find((p) => p.isGoalkeeper); }

  dispose() {
    for (const p of (this.allPlayers || this.players)) p.dispose();
    this.players = [];
    this.teams = [[], []];
  }
}
