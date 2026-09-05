import { KIT_SWATCHES } from '../utils/Constants.js';

const SKIN_TONES = [0xf1c9a5, 0xd9a37b, 0xc48c63, 0xa8734f, 0x8c5a3c, 0x6b4a32];
const HAIR_COLORS = [0x111111, 0x2a1a10, 0x6b3b1a, 0xd9b26f, 0xb03a2e, 0xdddddd];
const HAIR_STYLES = ['SHAVED', 'CLASSIC', 'CAP', 'FLAT TOP'];

/**
 * Locker: customise the human player's kit colours, name, number and look. Changes are previewed
 * live on the menu showcase model through onChange.
 */
export class LockerMenu {
  constructor(root, settings, { onClose, onChange, audio }) {
    this.settings = settings;
    this.audio = audio;
    this.onChange = onChange;
    this.el = document.createElement('div');
    this.el.className = 'screen panel-screen hidden';
    this.el.innerHTML = `
      <div class="panel">
        <h2>Locker<small>Your player</small></h2>
        <div class="locker-row"><label>Name</label><input class="text-input" maxlength="14" data-name></div>
        <div class="locker-row"><label>Number</label><input class="text-input" type="number" min="1" max="99" data-number style="max-width:120px"></div>
        <div class="locker-row"><label>Shirt</label><div class="swatches" data-shirt></div></div>
        <div class="locker-row"><label>Shorts</label><div class="swatches" data-shorts></div></div>
        <div class="locker-row"><label>Skin</label><div class="swatches" data-skin></div></div>
        <div class="locker-row"><label>Hair</label><div class="swatches" data-hair></div></div>
        <div class="locker-row"><label>Hair style</label><div class="seg" data-hairstyle></div></div>
        <p class="note">Your kit colours are applied to the whole BLUE team. Drop a rigged GLB into /public/assets/models/player.glb to replace the built-in model.</p>
        <div class="panel-actions"><button class="btn accent" data-action="close">Done</button></div>
      </div>`;
    root.appendChild(this.el);
    this.build();
    this.el.querySelector('[data-action="close"]').addEventListener('click', () => { audio.play('click'); onClose(); });
  }

  swatches(container, colors, key) {
    container.innerHTML = '';
    for (const c of colors) {
      const s = document.createElement('div');
      s.className = 'swatch' + (this.settings.profile[key] === c ? ' active' : '');
      s.style.background = '#' + c.toString(16).padStart(6, '0');
      s.addEventListener('click', () => {
        this.audio.play('click', { volume: 0.4 });
        this.settings.setProfile({ [key]: c });
        container.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
        s.classList.add('active');
        this.onChange(this.settings.profile);
      });
      container.appendChild(s);
    }
  }

  build() {
    const p = this.settings.profile;
    const name = this.el.querySelector('[data-name]');
    name.value = p.playerName;
    name.addEventListener('input', () => { this.settings.setProfile({ playerName: name.value.toUpperCase().slice(0, 14) || 'YOU' }); this.onChange(this.settings.profile); });
    const num = this.el.querySelector('[data-number]');
    num.value = p.shirtNumber;
    num.addEventListener('input', () => { const v = Math.max(1, Math.min(99, parseInt(num.value) || 10)); this.settings.setProfile({ shirtNumber: v }); this.onChange(this.settings.profile); });
    this.swatches(this.el.querySelector('[data-shirt]'), KIT_SWATCHES, 'shirtColor');
    this.swatches(this.el.querySelector('[data-shorts]'), KIT_SWATCHES, 'shortsColor');
    this.swatches(this.el.querySelector('[data-skin]'), SKIN_TONES, 'skinTone');
    this.swatches(this.el.querySelector('[data-hair]'), HAIR_COLORS, 'hairColor');
    const seg = this.el.querySelector('[data-hairstyle]');
    HAIR_STYLES.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('active', p.hairStyle === i);
      b.addEventListener('click', () => {
        this.audio.play('click', { volume: 0.4 });
        this.settings.setProfile({ hairStyle: i });
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.onChange(this.settings.profile);
      });
      seg.appendChild(b);
    });
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
}
