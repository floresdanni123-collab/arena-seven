/**
 * Pause overlay (ESC) and the full-time result screen.
 */
export class PauseMenu {
  constructor(root, { onResume, onSettings, onQuit, audio }) {
    this.el = document.createElement('div');
    this.el.className = 'screen pause-screen hidden';
    this.el.innerHTML = `
      <div class="pause-title">Paused</div>
      <nav class="pause-nav">
        <button class="menu-btn primary" style="--i:0" data-action="resume"><span class="label">Resume</span></button>
        <button class="menu-btn" style="--i:1" data-action="settings"><span class="label">Settings</span></button>
        <button class="menu-btn" style="--i:2" data-action="quit"><span class="label">Quit to menu</span></button>
      </nav>
    `;
    root.appendChild(this.el);
    const handlers = { resume: onResume, settings: onSettings, quit: onQuit };
    this.el.querySelectorAll('.menu-btn').forEach((btn) => {
      btn.addEventListener('mouseenter', () => audio.play('hover', { volume: 0.5 }));
      btn.addEventListener('click', () => { audio.play('click'); handlers[btn.dataset.action](); });
    });
  }
  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
}

export class ResultScreen {
  constructor(root, { onRematch, onMenu, audio }) {
    this.el = document.createElement('div');
    this.el.className = 'screen pause-screen hidden';
    this.el.innerHTML = `
      <div class="result-sub" data-sub>FULL TIME</div>
      <div class="pause-title" data-title>Draw</div>
      <div class="result-score"><span class="b" data-b>0</span><span>-</span><span class="r" data-r>0</span></div>
      <div class="result-sub" data-detail style="color: var(--muted); font-size: 16px;"></div>
      <nav class="pause-nav">
        <button class="menu-btn primary" style="--i:0" data-action="rematch"><span class="label">Rematch</span></button>
        <button class="menu-btn" style="--i:1" data-action="menu"><span class="label">Main menu</span></button>
      </nav>
    `;
    root.appendChild(this.el);
    const handlers = { rematch: onRematch, menu: onMenu };
    this.el.querySelectorAll('.menu-btn').forEach((btn) => {
      btn.addEventListener('mouseenter', () => audio.play('hover', { volume: 0.5 }));
      btn.addEventListener('click', () => { audio.play('click'); handlers[btn.dataset.action](); });
    });
  }

  show({ score, human, winner, shootout }) {
    const [b, r] = score;
    this.el.querySelector('[data-b]').textContent = b;
    this.el.querySelector('[data-r]').textContent = r;
    const won = winner === 0, lost = winner === 1;
    const title = won ? 'Victory' : lost ? 'Defeat' : 'Draw';
    this.el.querySelector('[data-title]').textContent = title;
    this.el.querySelector('[data-sub]').textContent = shootout ? `FULL TIME · PENALTIES ${shootout[0]}-${shootout[1]}` : 'FULL TIME';
    const s = human ? human.stats : null;
    this.el.querySelector('[data-detail]').textContent = s ? `YOU: ${s.goals} GOALS  ·  ${s.shots} SHOTS  ·  ${s.tackles} TACKLES  ·  ${s.jukes} JUKES  ·  ${s.saves} SAVES` : '';
    this.el.classList.remove('hidden');
  }
  hide() { this.el.classList.add('hidden'); }
}
