import { PITCH, TEAM } from '../utils/Constants.js';

/**
 * Goal detection. A goal is scored only when the whole ball has crossed the goal line between the
 * posts and under the crossbar. Tracks the ball's previous side of the line so a ball placed behind
 * the goal (or rolling around the back) never counts.
 */
export class GoalSystem {
  constructor(goals, events) {
    this.goals = goals; // [goalAtMinusZ (BLUE defends), goalAtPlusZ (RED defends)]
    this.events = events;
    this.armed = true;
    this.wasBehind = [false, false];
  }

  reset() { this.armed = true; this.wasBehind = [false, false]; }

  update(ball) {
    if (!this.armed) return;
    for (let i = 0; i < this.goals.length; i++) {
      const g = this.goals[i];
      const s = g.side;
      // "Fully behind" = the whole ball is past the line. We only fire on the transition into that
      // state, so a ball already sitting behind the line (e.g. rolled around the outside) never counts.
      const fullyBehind = s > 0 ? ball.position.z - ball.radius > g.lineZ : ball.position.z + ball.radius < g.lineZ;
      const inside = fullyBehind && g.isInMouth(ball.position.x, ball.position.y);
      if (inside && !this.wasBehind[i]) {
        // Goal at +Z is defended by RED, so BLUE scores there.
        const scoringTeam = s > 0 ? TEAM.BLUE : TEAM.RED;
        const scorer = ball.lastTouch || ball.lastKicker;
        const ownGoal = scorer ? scorer.team !== scoringTeam : false;
        this.armed = false;
        this.events.emit('goal', { team: scoringTeam, scorer, ownGoal, goal: g });
        return;
      }
      this.wasBehind[i] = inside;
    }
  }
}
