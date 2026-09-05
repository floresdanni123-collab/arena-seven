/**
 * Career stats panel backed by Settings.stats (persisted).
 */
export class StatsMenu {
  constructor(root, settings, { onClose, audio }) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'screen panel-screen hidden';
    this.el.innerHTML = `
      <div class="panel">
        <h2>Stats<small>Career record</small></h2>
        <div class="stat-grid" data-grid></div>
        <div class="panel-actions"><button class="btn accent" data-action="close">Back</button></div>
      </div>`;
    root.appendChild(this.el);
    this.grid = this.el.querySelector('[data-grid]');
    this.el.querySelector('[data-action="close"]').addEventListener('click', () => { audio.play('click'); onClose(); });
  }

  show() {
    const s = this.settings.stats;
    const cards = [
      ['Matches', s.matches], ['Wins', s.wins], ['Draws', s.draws], ['Losses', s.losses],
      ['Goals for', s.goalsFor], ['Goals against', s.goalsAgainst],
      ['Your goals', s.playerGoals], ['Tackles won', s.tackles], ['Jukes landed', s.jukes],
      ['Shots', s.shots], ['Win rate', s.matches ? Math.round((s.wins / s.matches) * 100) + '%' : '-']
    ];
    this.grid.innerHTML = cards.map(([k, v]) => `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    this.el.classList.remove('hidden');
  }
  hide() { this.el.classList.add('hidden'); }
}
