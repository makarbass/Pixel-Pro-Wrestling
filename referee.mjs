import { FLOOR, RING, clamp, gatesNear, matPoint, walkDistance } from './arena.mjs';

export const REFEREE_ATTACK_LIMIT = 3;
const STAGGER_TIME = 1;
const DOWN_TIME = 1.8;
const WATCH_SPEED = 60;
const EPSILON = 1e-8;

export function createReferee() {
  return {
    x: RING.width / 2, z: 4, height: RING.height, surface: 'mat', facing: -1, moving: false,
    phase: 'standing', attacks: 0, changedAt: 0, until: 0, interaction: null, escape: null, watchCorner: null
  };
}

export const canRefereeCount = (referee) => referee.phase === 'standing';
export const canHitReferee = (referee) => referee.phase === 'standing' || referee.phase === 'staggered';
export const refereeHasLeft = (referee) => referee.phase === 'fleeing' || referee.phase === 'gone';

export function walkRefereeAroundFighters(referee, [first, second], dt) {
  const left = Math.min(first.x, second.x) - 22;
  const right = Math.max(first.x, second.x) + 22;
  const back = Math.min(first.z, second.z) - 12;
  const front = Math.max(first.z, second.z) + 12;
  const corners = [matPoint(left, back), matPoint(right, back), matPoint(right, front), matPoint(left, front)];

  if (referee.watchCorner === null) {
    referee.watchCorner = corners.reduce((nearest, corner, index) =>
      walkDistance(referee, corner) < walkDistance(referee, corners[nearest]) ? index : nearest, 0);
  }
  let target = corners[referee.watchCorner];
  let distance = walkDistance(referee, target);
  if (distance <= EPSILON) {
    referee.watchCorner = (referee.watchCorner + 1) % corners.length;
    target = corners[referee.watchCorner];
    distance = walkDistance(referee, target);
  }

  const progress = distance > EPSILON ? Math.min(1, WATCH_SPEED * dt / distance) : 1;
  const dx = target.x - referee.x;
  const dxFacing = Math.abs(dx) > EPSILON ? dx : (first.x + second.x) / 2 - referee.x;
  if (Math.abs(dxFacing) > EPSILON) referee.facing = Math.sign(dxFacing);
  referee.x += dx * progress;
  referee.z += (target.z - referee.z) * progress;
  referee.moving = distance > EPSILON;
  if (progress === 1) referee.watchCorner = (referee.watchCorner + 1) % corners.length;
}

function startEscape(referee, now) {
  const [left, right] = gatesNear(referee);
  const gate = referee.x <= RING.width / 2 ? left : right;
  const leftward = gate === left;
  const edge = FLOOR.side + 80;
  const exitX = leftward ? -edge : RING.width + edge;
  const start = { x: referee.x, z: referee.z, height: referee.height, surface: 'mat' };
  const mat = { ...gate.mat, height: RING.height, surface: 'mat' };
  const floor = { ...gate.floor, height: 0, surface: 'floor' };
  const exit = { ...floor, x: exitX };
  referee.phase = 'fleeing';
  referee.facing = leftward ? -1 : 1;
  referee.escape = [
    { from: start, to: start, duration: 0.22, moving: false },
    { from: start, to: mat, duration: walkDistance(start, mat) / 142, moving: true },
    { from: mat, to: floor, duration: 0.30, moving: false },
    { from: floor, to: exit, duration: Math.abs(exit.x - floor.x) / 167, moving: true }
  ];
  advanceReferee(referee, now);
}

export function knockRefereeDown(referee, now) {
  referee.attacks += 1;
  referee.phase = 'down';
  referee.changedAt = now;
  referee.until = now + DOWN_TIME;
  referee.height = RING.height;
  referee.moving = false;
  if (referee.attacks === REFEREE_ATTACK_LIMIT) startEscape(referee, now);
}

export function hitReferee(referee, now, heavy) {
  if (heavy || referee.phase === 'staggered') {
    knockRefereeDown(referee, now);
    return;
  }
  referee.phase = 'staggered';
  referee.changedAt = now;
  referee.until = now + STAGGER_TIME;
  referee.moving = false;
}

export function advanceReferee(referee, now) {
  if (referee.phase === 'fleeing') {
    let time = now - referee.changedAt;
    for (const [index, { from, to, duration, moving }] of referee.escape.entries()) {
      if (time >= duration) {
        time -= duration;
        continue;
      }
      const progress = clamp(time / duration, 0, 1);
      referee.x = from.x + (to.x - from.x) * progress;
      referee.z = from.z + (to.z - from.z) * progress;
      referee.height = from.height + (to.height - from.height) * progress;
      referee.surface = index >= 2 ? 'floor' : 'mat';
      referee.moving = moving;
      return;
    }
    Object.assign(referee, referee.escape.at(-1).to, { phase: 'gone', moving: false });
    return;
  }
  if (!referee.interaction && (referee.phase === 'staggered' || referee.phase === 'down') && now + EPSILON >= referee.until) {
    referee.phase = 'standing';
    referee.changedAt = now;
  }
}
