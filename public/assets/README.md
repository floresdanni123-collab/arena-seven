# Drop-in assets

Put replacement assets in these folders. Anything missing falls back to the built-in procedural version.

- `models/player.glb`, `models/goalkeeper.glb`, `models/ball.glb`
- `animations/<clipName>.glb` (idle, walk, jog, sprint, dribble, low_kick, hard_kick, slide_tackle, juke_left,
  juke_right, fall, recover, celebrate, gk_idle, gk_move, gk_dive_left, gk_dive_right, gk_catch, gk_parry,
  gk_pickup, gk_throw, gk_kick)
- `textures/grass.jpg`, `textures/ball.png`
- `audio/*.mp3` (kick, pass, tackle, slide, juke, post, bounce, whistle, whistle_long, goal, save, catch,
  crowd, crowd_ooh, hover, click, ready, stun, menu_music)

Exact paths and material-name matching rules are in `src/assets/AssetManifest.js`.
