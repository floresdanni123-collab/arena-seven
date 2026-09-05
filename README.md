# Arena Seven - Arcade 7v7 Football

A fast, browser-based 3D arcade football game (futsal-style 7v7) built with JavaScript, Three.js and Vite.

## Run it

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`) in Chrome or Edge. Click **Play**, then click the pitch once to lock the mouse.

`npm run build` produces a static build in `dist/`; `npm run preview` serves it.

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move (relative to the camera) |
| Mouse | Camera / aim direction |
| Shift | Sprint (longer dribble touches, camera zooms out) |
| Left mouse | Hard kick: instant, high velocity, lifts the ball. Aim higher (lower camera) to loft it |
| Right mouse (hold) | Charged low kick. 0-0.2s soft pass, 0.2-0.5s pass, 0.5-0.8s strong pass, 0.8-1.1s driven shot, 1.1s max |
| E | Slide tackle (10s cooldown). Must physically reach the ball or the carrier |
| Q | Juke / evade (10s cooldown). Evade window is the first 0.3s only |
| Tab | Cycle through your team, goalkeeper included (keeper AI pauses while you control them) |
| Space | Switch to the teammate nearest the ball (when you don't have it); skips a replay |
| R | Training mode only: reset the ball to your feet |
| Esc | Pause |
| F3 | Debug overlay (AI targets, formation anchors, tackle hitboxes, keeper prediction, states) |

Time a juke so the evade window overlaps an opponent's slide and the tackle fails - they slide straight past.

**Pass switching:** when the player you control makes an intentional pass or throw to a teammate, control
moves to the receiver immediately (camera glides over). Shots, AI passes, deflections and keeper
distribution never switch you.

### Goalkeeper controls (after Tab-switching to your keeper)

| Input | Action |
| --- | --- |
| W A S D / Shift | Move (fast lateral shuffle inside the box) / rush |
| Left mouse | Dive toward the aim; camera pitch picks low / mid / high. With the ball: powerful kick |
| Right mouse | Catch or smother a nearby ball. With the ball: hold and release to throw (short tap = roll) |
| E | Rush-and-smother a loose ball nearby |
| Q | Quick lateral shuffle burst |

Hands are only allowed inside your own penalty area. Outside it dives only block with the body and
catching is refused.

### Set pieces

| Restart | Controls |
| --- | --- |
| Free kick / corner / goal kick | Mouse aims, right mouse (hold) driven kick, left mouse hard kick |
| Throw-in | Right mouse (hold) throw power, left mouse strong throw |
| Penalty | Right mouse (hold) placed shot, left mouse power shot; the taker runs up automatically |

Goal kicks are taken by the keeper AI unless you Tab to the keeper first.

## Rules

7v7, one goalkeeper per team, no offside, five minute match (configurable in Settings). A goal counts only
when the whole ball crosses the line between the posts and under the bar. The referee (RulesManager +
FoulManager) judges slide tackles by contact order: playing the ball first is clean, hitting the player
first or sliding in with the ball nowhere near is a foul. Fouls give free kicks, fouls inside the
defender's own box give penalties, dangerous or repeated fouls draw yellow and red cards (a red card removes
the player for the rest of the match), and a simple advantage rule lets clearly dangerous possession run.
Balls over the touchline give throw-ins, over the goal line corners or goal kicks by last touch. Goals,
significant saves and near misses play a short cinematic replay from the recorded buffer before the
restart. A drawn match goes to a five-a-side penalty shootout with sudden death.

## Project structure

```
src/
  core/      Game (state machine + frame loop), SceneManager (renderer/lights/post), InputManager,
             AudioManager (Web Audio + synthesised fallbacks), AssetLoader, Settings, EventBus
  player/    Player (entity + abilities), PlayerController (human input), PlayerStateMachine,
             PlayerAnimationController (procedural + AnimationMixer backends), PlayerModel,
             ProceduralHumanoid, ProceduralClips
  ball/      Ball, BallPhysics (gravity, drag, Magnus, bounce, posts, boards, nets, bodies),
             PossessionSystem (spring-based dribbling, trapping, keeper hold)
  ai/        AIPlayer (outfield brain), GoalkeeperAI, TeamAI (roles/tasks), FormationSystem
  match/     MatchManager (flow + simulation order), GoalSystem, TeamManager
  camera/    PlayerCamera (third person), CinematicCamera (menu)
  ui/        MainMenu, HUD, PauseMenu (+ result screen), SettingsMenu, LockerMenu, StatsMenu
  world/     Pitch, Goal, Stadium
  debug/     DebugRenderer
  utils/     Constants (all tuning values), MathUtils
  assets/    AssetManifest (which files the game looks for)
public/assets/  models/ animations/ textures/ audio/  (drop-in replacement assets)
```

## Replacing the built-in characters, animations and sounds

Everything visual and audible has a procedural stand-in so the game is complete without external files.
Drop real assets into `public/assets/` and they are picked up automatically (see `src/assets/AssetManifest.js`):

* `models/player.glb` (and optionally `goalkeeper.glb`): a rigged humanoid. Materials or meshes whose names
  contain `shirt`, `shorts`, `sock`, `skin`, `hair` or `boot` are recoloured per team/kit. Set `rig.scale`
  in the manifest for centimetre-scaled exports.
* `animations/<name>.glb`: one clip per file, keyed by the logical names in the manifest (`idle`, `walk`,
  `jog`, `sprint`, `dribble`, `lowKick`, `hardKick`, `slideTackle`, `jukeLeft`, `jukeRight`, `fall`,
  `recover`, `celebrate`, `gkIdle`, `gkMove`, `gkDiveLeft`, `gkDiveRight`, `gkCatch`, `gkParry`,
  `gkPickup`, `gkThrow`, `gkKick`). Clips baked into `player.glb` with those names also work. Missing clips
  fall back to sensible aliases. When a GLB is present the game drives it with `THREE.AnimationMixer`
  (blended locomotion weights + one-shot actions).
* `audio/*.mp3`: `kick`, `pass`, `tackle`, `slide`, `juke`, `post`, `bounce`, `whistle`, `whistle_long`,
  `goal`, `save`, `catch`, `crowd`, `crowd_ooh`, `hover`, `click`, `ready`, `stun`, `menu_music`.
* `textures/grass.jpg`, `textures/ball.png`.

## Tuning

All gameplay numbers live in `src/utils/Constants.js` (pitch size, ball physics, player speeds, control
offsets, tackle/juke timings, kick power curve, goalkeeper reaction and reach, AI difficulty profiles).
