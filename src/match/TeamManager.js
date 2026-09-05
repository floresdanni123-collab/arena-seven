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
 */
export class TeamManager {
  constructor({ assets, scene, settings, formation = '2-3-1', training = false }) {
    this.assets = assets;
    this.scene = scene;
    this.settings = settings;
    this.training = training;
    this.formationName = formation;
    this.formation = new FormationSystem(formation);
    this.players = [];
    this.teams = [[], []];
    this.teamAIs = [];
    this.human = null;
    this.difficulty = AI_DIFFICULTY[settings.get('difficulty')] || AI_DIFFICULTY.NORMAL;
  }

  build() {
    const profile = this.settings.profile;
    const kits = [
      { shirt: profile.shirtColor ?? COLORS.BLUE_SHIRT, shorts: profile.shortsColor ?? COLORS.BLUE_SHORTS, socks: profile.shirtColor ?? COLORS.SOCKS_BLUE, gk: COLORS.BLUE_GK },
      { shirt: COLORS.RED_SHIRT, shorts: COLORS.RED_SHORTS, socks: COLORS.SOCKS_RED, gk: COLORS.RED_GK }
    ];
    // Avoid identical kits if the player picked red for their team.
    if (Math.abs(kits[0].shirt - kits[1].shirt) < 0x101010) { kits[1].shirt = 0xffffff; kits[1].shorts = 0x1b1b24; kits[1].socks = 0xffffff; }

    const usedNames = new Set();
    let id = 0;
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const teamAI = new TeamAI(team, this.formation, this.difficulty);
      this.teamAIs[team] = teamAI;
      const kit = kits[team];
      this.formation.slots.forEach((slot, slotIndex) => {
        const isGK = slot.role === ROLE.GOALKEEPER;
        const isHuman = team === TEAM.BLUE && slot.role === ROLE.ATTACKER;
        // Training mode: the opposition fields only a goalkeeper.
        if (this.training && team === TEAM.RED && !isGK) return;
        let name;
        do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
        usedNames.add(name);
        const number = isGK ? 1 : (isHuman ? profile.shirtNumber : 2 + slotIndex + (team === TEAM.RED ? 7 : 0));
        const skin = isHuman ? profile.skinTone : pick(SKIN);
        const hair = isHuman ? profile.hairColor : pick(HAIR);
        const hairStyle = isHuman ? profile.hairStyle : Math.floor(Math.random() * 4);
        const model = new PlayerModel({
          assets: this.assets, goalkeeper: isGK,
          shirtColor: isGK ? kit.gk : kit.shirt, shortsColor: isGK ? 0x111111 : kit.shorts, socksColor: kit.socks,
          skinTone: skin, hairColor: hair, hairStyle, number, name: isHuman ? (profile.playerName || 'YOU') : name.split(' ')[1].toUpperCase()
        });
        const player = new Player({ id: id++, team, role: slot.role, name: isHuman ? (profile.playerName || 'YOU') : name, number, model, isHuman, difficulty: this.difficulty });
        player.slotIndex = slotIndex;
        this.scene.add(model.root);
        if (isHuman) { this.human = player; model.showName(true); model.setMarker(0xb8ff3b); }
        else if (isGK) player.ai = new GoalkeeperAI(player, teamAI, this.difficulty);
        else player.ai = new AIPlayer(player, teamAI, this.difficulty);
        this.players.push(player);
        this.allPlayers = this.allPlayers || [];
        this.allPlayers.push(player);
        this.teams[team].push(player);
      });
      teamAI.setPlayers(this.teams[team]);
    }
    return this;
  }

  getGoalkeeper(team) { return this.teams[team].find((p) => p.isGoalkeeper); }

  dispose() {
    for (const p of (this.allPlayers || this.players)) p.dispose();
    this.players = [];
    this.teams = [[], []];
  }
}
