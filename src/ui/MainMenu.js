/**
 * Main menu overlay rendered on top of the cinematic stadium scene.
 */
export class MainMenu {
  constructor(root, { onPlay, onTraining, onLocker, onStats, onSettings, audio }) {
    this.audio = audio;
    this.el = document.createElement('div');
    this.el.className = 'screen menu-screen hidden';
    this.el.innerHTML = `
      <div class="menu-brand">
        <div class="title">Arena<br/><span>Seven</span></div>
        <div class="subtitle">Arcade 7v7 Football</div>
      </div>
      <nav class="menu-nav">
        <button class="menu-btn primary" style="--i:0" data-action="play"><span class="label">Play</span><span class="hint">Local match vs AI</span></button>
        <button class="menu-btn" style="--i:1" data-action="training"><span class="label">Training</span><span class="hint">Free practice pitch</span></button>
        <button class="menu-btn" style="--i:2" data-action="locker"><span class="label">Locker</span><span class="hint">Kit, name and look</span></button>
        <button class="menu-btn" style="--i:3" data-action="stats"><span class="label">Stats</span><span class="hint">Your record</span></button>
        <button class="menu-btn" style="--i:4" data-action="settings"><span class="label">Settings</span><span class="hint">Audio, video, controls</span></button>
      </nav>
      <div class="menu-footer">
        <span><kbd>WASD</kbd> Move</span><span><kbd>Shift</kbd> Sprint</span><span><kbd>LMB</kbd> Hard kick</span><span><kbd>RMB</kbd> Low kick (hold)</span><span><kbd>E</kbd> Slide tackle</span><span><kbd>Q</kbd> Juke</span>
      </div>
      <div class="menu-version">ARENA SEVEN v0.1 &middot; F3 DEBUG</div>
    `;
    root.appendChild(this.el);
    const handlers = { play: onPlay, training: onTraining, locker: onLocker, stats: onStats, settings: onSettings };
    this.el.querySelectorAll('.menu-btn').forEach((btn) => {
      btn.addEventListener('mouseenter', () => audio.play('hover', { volume: 0.5 }));
      btn.addEventListener('click', (e) => { audio.play('click'); const h = handlers[btn.dataset.action]; if (h) h(e); });
    });
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
}
