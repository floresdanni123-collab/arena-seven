import { Game } from './core/Game.js';

const canvas = document.getElementById('game-canvas');
const game = new Game(canvas);
window.__game = game; // handy for console debugging
game.start().catch((e) => console.error('[Arena Seven] failed to start', e));
