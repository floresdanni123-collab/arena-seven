/**
 * Central asset manifest.
 *
 * Any file listed here that exists under /public/assets is used automatically. Missing files fall back
 * to built-in procedural stand-ins (procedural humanoid + procedural animation, synthesised audio).
 *
 * To drop in real humanoid GLB models:
 *   1. Put a rigged character at /public/assets/models/player.glb (optionally goalkeeper.glb).
 *   2. Put animation clips at /public/assets/animations/<name>.glb (one clip per file, same rig),
 *      OR bake all clips into player.glb and name them like the keys below.
 *   3. Name the character's materials/meshes so shirt/shorts/skin/socks/hair can be recoloured
 *      (matching is case-insensitive substring on material OR mesh name).
 */
export const ASSET_MANIFEST = {
  models: {
    player: '/assets/models/player.glb',
    goalkeeper: '/assets/models/goalkeeper.glb',
    ball: '/assets/models/ball.glb'
  },

  // Logical animation name -> file. Clips inside player.glb with the same names take priority.
  animations: {
    idle: '/assets/animations/idle.glb',
    walk: '/assets/animations/walk.glb',
    jog: '/assets/animations/jog.glb',
    sprint: '/assets/animations/sprint.glb',
    dribble: '/assets/animations/dribble.glb',
    lowKick: '/assets/animations/low_kick.glb',
    hardKick: '/assets/animations/hard_kick.glb',
    slideTackle: '/assets/animations/slide_tackle.glb',
    jukeLeft: '/assets/animations/juke_left.glb',
    jukeRight: '/assets/animations/juke_right.glb',
    fall: '/assets/animations/fall.glb',
    recover: '/assets/animations/recover.glb',
    celebrate: '/assets/animations/celebrate.glb',
    gkIdle: '/assets/animations/gk_idle.glb',
    gkMove: '/assets/animations/gk_move.glb',
    gkDiveLeft: '/assets/animations/gk_dive_left.glb',
    gkDiveRight: '/assets/animations/gk_dive_right.glb',
    gkCatch: '/assets/animations/gk_catch.glb',
    gkParry: '/assets/animations/gk_parry.glb',
    gkPickup: '/assets/animations/gk_pickup.glb',
    gkThrow: '/assets/animations/gk_throw.glb',
    gkKick: '/assets/animations/gk_kick.glb'
  },

  // Substrings used to identify recolourable materials on imported GLB characters.
  materialNames: {
    shirt: ['shirt', 'jersey', 'top', 'kit'],
    shorts: ['shorts', 'pants'],
    socks: ['sock'],
    skin: ['skin', 'body', 'face', 'head', 'arm'],
    hair: ['hair'],
    boots: ['boot', 'shoe']
  },

  // Rig hints for GLB models: which bone names hold the feet (used for ball contact/dribble offsets).
  rig: {
    rightFoot: ['mixamorigRightFoot', 'RightFoot', 'foot_r', 'R_Foot'],
    leftFoot: ['mixamorigLeftFoot', 'LeftFoot', 'foot_l', 'L_Foot'],
    scale: 1.0 // set to 0.01 for centimetre-scaled Mixamo exports
  },

  audio: {
    kick: '/assets/audio/kick.mp3',
    pass: '/assets/audio/pass.mp3',
    tackle: '/assets/audio/tackle.mp3',
    slide: '/assets/audio/slide.mp3',
    juke: '/assets/audio/juke.mp3',
    post: '/assets/audio/post.mp3',
    bounce: '/assets/audio/bounce.mp3',
    whistle: '/assets/audio/whistle.mp3',
    whistle_long: '/assets/audio/whistle_long.mp3',
    goal: '/assets/audio/goal.mp3',
    save: '/assets/audio/save.mp3',
    catch: '/assets/audio/catch.mp3',
    crowd: '/assets/audio/crowd.mp3',
    crowd_ooh: '/assets/audio/crowd_ooh.mp3',
    hover: '/assets/audio/hover.mp3',
    click: '/assets/audio/click.mp3',
    ready: '/assets/audio/ready.mp3',
    stun: '/assets/audio/stun.mp3',
    music: '/assets/audio/menu_music.mp3'
  },

  textures: {
    grass: '/assets/textures/grass.jpg',
    ballAlbedo: '/assets/textures/ball.png'
  }
};
