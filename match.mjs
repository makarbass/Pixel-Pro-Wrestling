import {
  RING, FLOOR, EDGES, CORNERS, clamp, matPoint, floorPoint, surfacePoint, nearCorner,
  edgePressed, contactAlong, inward, gatesNear, walkDistance
} from './arena.mjs';
import { GRAPPLES, SIGNATURES, TACTICS } from './roster.mjs';
import { advanceReferee, canHitReferee, canRefereeCount, createReferee, hitReferee,
  knockRefereeDown, refereeHasLeft, walkRefereeAroundFighters } from './referee.mjs';

export { RING } from './arena.mjs';
export const STEP = 1 / 60;
export const MATCH_SECONDS = 120;
export const OUTSIDE_COUNT = 10;
export const escapePresses = (health) => escapeThreshold(health, 8, 6);
export const getUpPresses = (health) => Math.round(4 + 6 * (1 - health / 100));

const EPSILON = 1e-8;
const GRAVITY = 340;
const PERCH_DELAY = 1.25;
const RUSH_WINDOW = 0.45;
const RUSH_BOOST = 0.30;
const TAUNT_DURATION = 0.75;
const TAUNT_COOLDOWN = 3.5;
const SIGNATURE_COOLDOWN = 5;
const COMBO_WINDOW = 0.65;
const COMBO_BUFFER = 0.15;
const IMPACT_DURATION = 0.18;
const DAMAGE_SCALE = 0.6;
const BOT_APPROACH_TIME = 0.75;
const BOT_GUARD_TIME = 1.25;
const RINGSIDE_RETURN = 6.3;
const CLINCH_LIMIT = 1.8;
const CLINCH_WINDUP = 0.5;
const SIGNATURE_CLINCH = 0.7;
const BOT_CLINCH_FINISH = 0.94;
const REFEREE_PIN_TIME = 1.5;
const REFEREE_BOT_INTERVAL = 10;
const REFEREE_BOT_CHANCE = 0.2;
const PIN_RELEASE_TIME = 2.4;
const PIN_PRESSURE_PER_TAP = 0.18;
const BOT_PIN_TAP_INTERVAL = 0.45;
const FRESH_DEFENDER_HEALTH = 80;
const FRESH_BOT_KICK_OUT_TIME = 1.65;
const GET_UP_TIME = 4;
const RISE_TIME = 0.36;
const WEAK_STRIKE_COOLDOWN = 1.2;
const GROUND_JUMP_TIME = 0.55;
const CORNER_CLIMB_TIME = 0.48;
const BOT_DIVE_DELAY = 0.18;
const BOT_FOLLOW_UP_DELAY = 0.8;
const BOT_HOME = {
  rush: { x: 116, z: 29 }, grapple: { x: 121, z: 26 },
  corner: { x: 124, z: 33 }, taunt: { x: 122, z: 23 }
};
const WALK = { x: 68, z: 43 };
const STRIKE = { duration: 0.38, impact: 0.14, reach: 23, depth: 9, damage: 10 };
const ATTACKS = {
  strike: STRIKE,
  rush: STRIKE,
  throw: { duration: 0.57, impact: 0.22, reach: 17, depth: 8, damage: 20 },
  shove: { duration: 0.48, impact: 0.24, reach: 24, depth: 12 }
};

function escapeThreshold(health, bonus, exponent) {
  const fatigue = 1 - health / 100;
  return Math.round(4 + 6 * fatigue + bonus * fatigue ** exponent);
}

function impactDamage(base, power = 1) {
  return Math.max(1, Math.round(base * power * DAMAGE_SCALE));
}

function wrestler(id, x, facing) {
  return {
    id, x, z: RING.depth / 2, facing, height: RING.height, surface: 'mat',
    health: 100, pose: 'idle', age: 0, attack: null, recover: 0, knockdown: null,
    motion: null, corner: null, lean: null, rush: null, tauntCooldown: 0,
    signatureCooldown: 0, weakStrikeCooldown: 0, combo: null, strideDistance: 0, gait: 'walk'
  };
}

export function createMatch(player = 'booker', opponent = 'taker', { random = Math.random } = {}) {
  return {
    fighters: [wrestler(player, 57, 1), wrestler(opponent, 143, -1)],
    clock: MATCH_SECONDS,
    elapsed: 0,
    crowdTime: 0,
    pin: null,
    pinBreak: null,
    hold: null,
    impacts: [],
    outside: { elapsed: 0, paused: 0, count: 0 },
    ropes: Object.fromEntries(EDGES.map((edge) => [edge, { flex: 0, position: 0.5 }])),
    end: null,
    referee: createReferee(),
    bot: { cooldown: 0.30, style: TACTICS[opponent] || 'grapple', random, plan: null, counter: 0,
      nextRefereeAttempt: REFEREE_BOT_INTERVAL, refereePlan: null }
  };
}

function setPose(fighter, pose) {
  if (fighter.pose !== pose) {
    fighter.pose = pose;
    fighter.age = 0;
    if (pose === 'walk') fighter.strideDistance = 0;
  }
}

function knockDown(match, fighter) {
  const fatigue = 1 - fighter.health / 100;
  fighter.knockdown = { startedAt: match.elapsed, deadline: match.elapsed + GET_UP_TIME,
    taps: 0, needed: getUpPresses(fighter.health), followUp: null };
  if (fighter === match.fighters[1]) {
    fighter.knockdown.nextBotTap = 0.4;
    fighter.knockdown.botTapInterval = 0.25 + 0.1 * fatigue + 0.12 * match.bot.random();
  }
  fighter.recover = 0;
  setPose(fighter, 'down');
}

function startRise(fighter) {
  fighter.knockdown = null;
  fighter.recover = RISE_TIME;
  setPose(fighter, 'rise');
}

function inRange(a, b, reach, depth) {
  return Math.abs(a.x - b.x) <= reach && Math.abs(a.z - b.z) <= depth;
}

function setFacing(fighter, opponent) {
  if (Math.abs(opponent.x - fighter.x) > 0.01) {
    fighter.facing = opponent.x > fighter.x ? 1 : -1;
  }
}

function grounded(fighter) {
  return !fighter.corner && (!fighter.motion || fighter.motion.kind === 'rebound');
}

function canAct(fighter) {
  return grounded(fighter) && !fighter.motion && !fighter.attack &&
    fighter.recover === 0 && fighter.pose !== 'taunt' && fighter.pose !== 'down' &&
    fighter.pose !== 'clinch' && fighter.pose !== 'held' &&
    fighter.pose !== 'grappling' && !fighter.pose.startsWith('caught');
}

const speedFactor = (fighter) => fighter.health === 0 ? 0.30 : 0.62 + 0.38 * fighter.health / 100;
const powerFactor = (fighter) => 0.55 + 0.45 * fighter.health / 100;
export function attackTimeline(fighter) {
  if (!fighter.attack) return null;
  return fighter.attack.name === 'signature' ? SIGNATURES[fighter.id] : ATTACKS[fighter.attack.name];
}

function resetHeight(fighter) {
  fighter.height = fighter.surface === 'mat' ? RING.height : 0;
}

function canUseSignature(fighter) {
  return fighter.surface === 'mat' && fighter.health > 0 && !fighter.lean &&
    fighter.signatureCooldown <= EPSILON && canAct(fighter) && Boolean(SIGNATURES[fighter.id]);
}

function canTaunt(fighter) {
  return fighter.surface === 'mat' && !fighter.lean && fighter.health > 0 && fighter.tauntCooldown <= EPSILON;
}

function routeToGate(fighter, target = fighter) {
  const here = fighter.surface;
  const there = here === 'mat' ? 'floor' : 'mat';
  const gates = gatesNear(here === 'mat' ? target : fighter);
  return gates.reduce((best, gate) => {
    const cost = (item) => walkDistance(fighter, item[here]) + 0.75 * walkDistance(item[there], target);
    return cost(gate) < cost(best) ? gate : best;
  });
}

export function availableInteraction(fighter) {
  if (fighter.corner && !fighter.motion) return { name: 'descend' };
  if (!canAct(fighter)) return null;
  if (fighter.surface === 'mat' && fighter.health > 0) {
    const corner = nearCorner(fighter);
    if (corner) return { name: 'climb', corner };
  }
  const gate = gatesNear(fighter).find((item) => inRange(fighter, item[fighter.surface], 6, 5));
  if (!gate) return null;
  return { name: fighter.surface === 'mat' ? 'exit' : 'enter', gate };
}

function beginMotion(fighter, kind, point, surface, height, duration) {
  fighter.lean = null;
  fighter.rush = null;
  fighter.combo = null;
  fighter.motion = {
    kind, duration, elapsed: 0,
    from: { x: fighter.x, z: fighter.z, height: fighter.height },
    to: { ...point, surface, height }
  };
  setPose(fighter, kind === 'rebound' ? 'walk' : kind);
  return fighter.motion;
}

function interact(fighter, action) {
  switch (action.name) {
    case 'climb': {
      const corner = action.corner;
      fighter.corner = corner;
      fighter.facing = inward(corner.side).x;
      beginMotion(fighter, 'climb', corner, 'mat', RING.height + RING.cornerHeight, CORNER_CLIMB_TIME);
      return;
    }
    case 'descend': {
      const { x, z } = fighter.corner;
      beginMotion(fighter, 'descend', matPoint(x, z), 'mat', RING.height, 0.32);
      return;
    }
    default: {
      const entering = action.name === 'enter';
      const destination = entering ? action.gate.mat : action.gate.floor;
      if (Math.abs(destination.x - fighter.x) > 7) fighter.facing = Math.sign(destination.x - fighter.x);
      beginMotion(fighter, action.name, destination, entering ? 'mat' : 'floor',
        entering ? RING.height : 0, entering ? 0.46 : 0.36);
    }
  }
}

function cornerLanding(corner, x, z) {
  const normal = inward(corner.side).x;
  if (!x && !z) {
    x = normal;
    z = corner.z === 0 ? 1 : -1;
  }
  const length = Math.max(1, Math.hypot(x, z));
  const landingX = corner.x + x * 61 / length;
  const landingZ = corner.z + z * 30 / length;
  if (x === -normal) {
    const side = normal === 1 ? -FLOOR.side : RING.width + FLOOR.side;
    return { target: floorPoint(landingX, landingZ, { x: side, z: FLOOR.back }), surface: 'floor', duration: 0.88 };
  }
  if (corner.z === RING.depth && z > 0) {
    const target = floorPoint(landingX, landingZ, { x: corner.x, z: FLOOR.threshold });
    return { target, surface: 'floor', duration: 0.88 };
  }
  return { target: matPoint(landingX, landingZ), surface: 'mat', duration: 0.76 };
}

function groundJumpTarget(fighter, x, z) {
  const length = Math.max(1, Math.hypot(x, z));
  const distance = GROUND_JUMP_TIME * speedFactor(fighter) / length;
  return surfacePoint(fighter, fighter.x + x * WALK.x * distance, fighter.z + z * WALK.z * distance);
}

function beginJump(fighter, command) {
  const x = command.x || 0;
  const z = command.z || 0;
  const corner = fighter.corner;
  const { target, surface, duration } = corner ? cornerLanding(corner, x, z) : {
    target: groundJumpTarget(fighter, x, z), surface: fighter.surface, duration: GROUND_JUMP_TIME
  };
  if (target.x !== fighter.x) fighter.facing = Math.sign(target.x - fighter.x);
  fighter.corner = null;
  const motion = beginMotion(fighter, 'jump', target, surface, surface === 'mat' ? RING.height : 0, duration);
  motion.fromCorner = Boolean(corner);
  motion.corner = corner;
  motion.strike = Boolean(command.strike);
  if (motion.strike) setPose(fighter, 'dive');
}

function advanceMotion(match, fighter, command, dt) {
  const motion = fighter.motion;
  const { from, to, kind, duration } = motion;
  if (kind === 'jump' && command.strike && !motion.strike) {
    motion.strike = true;
    setPose(fighter, 'dive');
  }
  const previousHeight = fighter.height;
  motion.elapsed = Math.min(duration, motion.elapsed + dt);
  const progress = motion.elapsed / duration;
  const x = from.x + (to.x - from.x) * progress;
  const z = from.z + (to.z - from.z) * progress;
  if (kind === 'jump' && !motion.fromCorner && fighter.surface === 'floor') {
    Object.assign(fighter, floorPoint(x, z, fighter));
  } else {
    fighter.x = x;
    fighter.z = z;
  }
  const arc = kind === 'jump' ? GRAVITY * motion.elapsed * (duration - motion.elapsed) / 2 : 0;
  const heightProgress = kind === 'fall' ? progress * progress : progress;
  fighter.height = from.height + (to.height - from.height) * heightProgress + arc;
  const landed = progress >= 1 - EPSILON;
  const jump = kind === 'jump' ? { motion, previousHeight, landed } : null;
  if (!landed) return jump;

  fighter.height = to.height;
  fighter.surface = to.surface;
  fighter.motion = null;
  if (kind === 'climb') {
    setPose(fighter, 'perch');
  } else {
    fighter.corner = null;
    if (kind === 'rebound' && fighter.rush?.queued) {
      beginRushStrike(fighter);
    } else if (kind === 'jump') {
      fighter.recover = motion.fromCorner || motion.strike ? 0.28 : 0.11;
      setPose(fighter, 'land');
    } else if (kind === 'fall') {
      fighter.health = Math.max(0, fighter.health - (motion.damage ?? impactDamage(10)));
      knockDown(match, fighter);
    } else {
      setPose(fighter, 'idle');
    }
  }
  return jump;
}

function releaseRope(fighter, command, x, z) {
  const direction = inward(fighter.lean);
  const compression = Math.min(1, 0.34 + fighter.age * 4.5);
  const force = compression * speedFactor(fighter);
  const target = matPoint(fighter.x + direction.x * 16 * force, fighter.z + direction.z * 10 * force);
  if (target.x !== fighter.x) fighter.facing = Math.sign(target.x - fighter.x);
  beginMotion(fighter, 'rebound', target, 'mat', RING.height, 0.19);
  fighter.rush = { ...direction, compression, remaining: RUSH_WINDOW, queued: false };
  updateRushCommand(fighter, command, x, z);
}

function forwardOf(rush, x, z) {
  return x * rush.x + z * rush.z;
}

function updateRushCommand(fighter, command, x, z) {
  const rush = fighter.rush;
  if (!rush) return;
  if (command.block || command.throw || command.jump || command.interact || command.taunt || command.signature ||
      command.pin || forwardOf(rush, x, z) < 0) {
    fighter.rush = null;
  } else if (command.strike) {
    rush.queued = true;
  }
}

function beginRushStrike(fighter) {
  const { x, z, compression, remaining } = fighter.rush;
  const speed = 1 + RUSH_BOOST * compression * remaining / RUSH_WINDOW;
  fighter.rush = null;
  if (x) fighter.facing = x;
  fighter.attack = { name: 'rush', time: 0, spent: false, x, z, speed };
  setPose(fighter, 'strike');
}

function advanceRushStrike(fighter, opponent, dt) {
  const attack = fighter.attack;
  const dx = opponent.x - fighter.x;
  const dz = opponent.z - fighter.z;
  const ahead = forwardOf(attack, dx, dz);
  const sameLane = attack.x ? Math.abs(dz) < 5 : Math.abs(dx) <= 10;
  const speed = (attack.x ? WALK.x : WALK.z) * attack.speed * speedFactor(fighter);
  let distance = Math.min(dt, STRIKE.impact - attack.time) * speed;
  if (grounded(opponent) && opponent.surface === fighter.surface && sameLane && ahead >= 0) {
    distance = Math.min(distance, Math.max(0, ahead - (attack.x ? 10 : 6)));
  }
  Object.assign(fighter, matPoint(fighter.x + attack.x * distance, fighter.z + attack.z * distance));
}

function ageFighter(fighter, dt) {
  fighter.age += dt;
  fighter.tauntCooldown = Math.max(0, fighter.tauntCooldown - dt);
  fighter.signatureCooldown = Math.max(0, fighter.signatureCooldown - dt);
  fighter.weakStrikeCooldown = Math.max(0, fighter.weakStrikeCooldown - dt);
  if (!fighter.combo) return;
  fighter.combo.remaining -= dt;
  if (fighter.combo.remaining < -EPSILON) fighter.combo = null;
}

function comboFollowUp(fighter, command) {
  if (!fighter.combo) return null;
  if (command.throw) return 'throw';
  if (command.strike && fighter.combo.hits === 1) return 'strike';
  return null;
}

function groundTarget(fighter, opponent, referee, move, preference) {
  if (preference === 'opponent' || !canHitReferee(referee) || fighter.surface !== referee.surface ||
      !inRange(fighter, referee, move.reach, move.depth)) return opponent;
  if (preference === 'referee') return referee;
  const opponentAvailable = grounded(opponent) && fighter.surface === opponent.surface && opponent.pose !== 'down' &&
    (opponent.recover <= EPSILON || fighter.combo && opponent.pose === 'hit' && opponent.recover < move.impact) &&
    inRange(fighter, opponent, move.reach, move.depth);
  return !opponentAvailable || walkDistance(fighter, referee) < walkDistance(fighter, opponent) ? referee : opponent;
}

function startGroundAttack(fighter, opponent, name) {
  const hits = comboFollowUp(fighter, { strike: name === 'strike', throw: name === 'throw' })
    ? fighter.combo.hits : 0;
  const canFollowHit = hits > 0 && opponent.pose === 'hit' && opponent.recover < ATTACKS[name].impact;
  if (!grounded(opponent) || fighter.surface !== opponent.surface || opponent.pose === 'down' ||
      (opponent.recover > EPSILON && !canFollowHit)) return;
  setFacing(fighter, opponent);
  fighter.combo = null;
  fighter.attack = { name, time: 0, spent: false, hits };
  setPose(fighter, name);
}

function advanceSignature(fighter, opponent, move, dt) {
  const { time } = fighter.attack;
  const travel = (move.travel || 0) * speedFactor(fighter) * Math.min(dt, Math.max(0, move.impact - time)) / move.impact;
  const ahead = (opponent.x - fighter.x) * fighter.facing;
  const distance = ahead >= 0 && inRange(fighter, opponent, 70, 6) && grounded(opponent) && opponent.surface === 'mat'
    ? Math.min(travel, Math.max(0, ahead - 11)) : travel;
  fighter.x = matPoint(fighter.x + fighter.facing * distance, fighter.z).x;
  if (move.lift) {
    const flight = clamp((time + dt - 0.06) / (move.impact + 0.13 - 0.06), 0, 1);
    fighter.height = RING.height + Math.sin(flight * Math.PI) * move.lift;
  }
}

function advanceAttack(fighter, opponent, command, dt) {
  const attack = fighter.attack;
  const move = attackTimeline(fighter);
  if (attack.name === 'rush' && attack.time < STRIKE.impact) advanceRushStrike(fighter, opponent, dt);
  if (attack.name === 'signature') advanceSignature(fighter, opponent, move, dt);
  if (attack.name === 'throw' && command.throw) attack.grabQueued = true;
  if (fighter.combo && move.duration - attack.time <= COMBO_BUFFER + dt) {
    if (command.throw && (fighter.combo.queued === 'throw' || command.throw > 1)) fighter.combo.grabQueued = true;
    fighter.combo.queued ||= comboFollowUp(fighter, command);
  }
  attack.time += dt;
  if (attack.time + EPSILON < move.duration) return;
  fighter.attack = null;
  resetHeight(fighter);
  setPose(fighter, 'idle');
  if (!fighter.combo?.queued) return;
  const { queued: next, grabQueued } = fighter.combo;
  fighter.combo.queued = null;
  startGroundAttack(fighter, opponent, next);
  if (fighter.attack?.name === 'throw' && grabQueued) fighter.attack.grabQueued = true;
}

function advanceWrestler(match, fighter, opponent, command, dt, preference) {
  const { referee } = match;
  const x = command.x || 0;
  const z = command.z || 0;
  ageFighter(fighter, dt);
  if (fighter.knockdown) return null;
  updateRushCommand(fighter, command, x, z);
  if (fighter.motion) return advanceMotion(match, fighter, command, dt);
  if (fighter.attack) {
    advanceAttack(fighter, fighter.attack.target === 'referee' ? referee : opponent, command, dt);
    return null;
  }
  if (fighter.pose === 'taunt') {
    if (fighter.age + EPSILON < TAUNT_DURATION) return null;
    setPose(fighter, 'idle');
  }
  if (fighter.recover > 0) {
    fighter.recover = Math.max(0, fighter.recover - dt);
    if (fighter.recover === 0) setPose(fighter, 'idle');
    return null;
  }

  const exhausted = fighter.health === 0;
  if (exhausted) {
    fighter.lean = null;
    fighter.rush = null;
  }
  const action = command.interact && availableInteraction(fighter);
  if (action) {
    interact(fighter, action);
    return null;
  }
  if (!exhausted && command.jump) {
    beginJump(fighter, command);
    return null;
  }
  if (fighter.corner) return null;

  if (fighter.lean) {
    const normal = inward(fighter.lean);
    if (forwardOf(normal, x, z) >= 0) releaseRope(fighter, command, x, z);
    return null;
  }
  if (fighter.rush?.queued) {
    beginRushStrike(fighter);
    return null;
  }
  if (command.signature && canUseSignature(fighter)) {
    const target = groundTarget(fighter, opponent, referee, SIGNATURES[fighter.id], preference);
    setFacing(fighter, target);
    fighter.combo = null;
    fighter.rush = null;
    fighter.signatureCooldown = SIGNATURE_COOLDOWN;
    fighter.attack = { name: 'signature', time: 0, spent: false };
    if (target === referee) fighter.attack.target = 'referee';
    setPose(fighter, 'signature');
    return null;
  }

  if (!exhausted && command.shove && opponent.pose === 'perch') {
    setFacing(fighter, opponent);
    fighter.attack = { name: 'shove', time: 0, spent: false };
    setPose(fighter, 'strike');
    return null;
  }
  const wantsThrow = !exhausted && command.throw;
  if (wantsThrow || command.strike && fighter.weakStrikeCooldown <= EPSILON) {
    const name = wantsThrow ? 'throw' : 'strike';
    const target = groundTarget(fighter, opponent, referee, ATTACKS[name], preference);
    if (target === referee) fighter.combo = null;
    startGroundAttack(fighter, target, name);
    if (fighter.attack) {
      if (exhausted) fighter.weakStrikeCooldown = WEAK_STRIKE_COOLDOWN;
      if (target === referee) fighter.attack.target = 'referee';
      if (name === 'throw' && command.throw > 1) fighter.attack.grabQueued = true;
      return null;
    }
  }
  if (!exhausted && command.block) {
    setPose(fighter, 'block');
    return null;
  }
  if (command.taunt && canTaunt(fighter)) {
    setFacing(fighter, opponent);
    fighter.tauntCooldown = TAUNT_COOLDOWN;
    fighter.combo = null;
    setPose(fighter, 'taunt');
    return null;
  }

  const length = Math.max(1, Math.hypot(x, z));
  const rush = fighter.rush;
  const boost = rush && forwardOf(rush, x, z) > 0
    ? 1 + RUSH_BOOST * rush.compression * rush.remaining / RUSH_WINDOW : 1;
  const speed = boost * speedFactor(fighter);
  if (rush) {
    rush.remaining -= dt;
    if (rush.remaining <= EPSILON) fighter.rush = null;
  }
  const nextX = fighter.x + x / length * WALK.x * dt * speed;
  const nextZ = fighter.z + z / length * WALK.z * dt * speed;
  const point = surfacePoint(fighter, nextX, nextZ);
  const edge = !exhausted && fighter.surface === 'mat' && edgePressed(nextX, nextZ, point);
  const movementX = point.x - fighter.x;
  Object.assign(fighter, point);
  if (edge) {
    fighter.rush = null;
    fighter.lean = edge;
    fighter.facing = inward(edge).x || fighter.facing;
    setPose(fighter, 'lean');
  } else {
    if (movementX !== 0) fighter.facing = Math.sign(movementX);
    setPose(fighter, x || z ? 'walk' : 'idle');
    fighter.gait = boost > 1.05 ? 'run' : 'walk';
  }
  return null;
}

function jumpContactWith(fighter, opponent, jump) {
  const { motion, previousHeight, landed } = jump;
  const sameSurface = grounded(opponent) && opponent.surface === motion.to.surface;
  const overlap = sameSurface && inRange(fighter, opponent, 23, 10);
  if (motion.fromCorner) {
    const top = opponent.height + (opponent.pose === 'down' ? 7 : 19);
    const overFloor = fighter.x <= -FLOOR.apron || fighter.x >= RING.width + FLOOR.apron || fighter.z >= FLOOR.threshold;
    const overTarget = opponent.surface === 'mat' ? !overFloor : overFloor;
    if (overlap && overTarget && fighter.height < previousHeight &&
        fighter.height <= top && previousHeight >= opponent.height) {
      return { damage: 20, fall: true, facing: fighter.facing, atMat: true, aerial: true };
    }
  } else if (landed && motion.strike && overlap && opponent.pose !== 'block') {
    return { damage: 10, fall: false, facing: fighter.facing, aerial: true };
  }
  return null;
}

function jumpContact(fighter, opponent, referee, jump) {
  const { motion, landed } = jump;
  if (motion.hit) return null;
  const opponentHit = jumpContactWith(fighter, opponent, jump);
  const refereeHit = !opponentHit && canHitReferee(referee) && jumpContactWith(fighter, referee, jump);
  if (opponentHit || refereeHit) {
    motion.hit = true;
    return opponentHit || { ...refereeHit, referee: true, heavy: motion.fromCorner };
  }
  if (landed && motion.fromCorner) fighter.recover = 0.54;
  return null;
}

function groundContactWith(fighter, opponent, move, againstReferee = false) {
  const { attack } = fighter;
  if (attack.name === 'shove') {
    return opponent.pose === 'perch' && inRange(fighter, opponent, move.reach, move.depth)
      ? { corner: opponent.corner, damage: 10, facing: fighter.facing }
      : null;
  }
  if (!grounded(opponent) || fighter.surface !== opponent.surface || opponent.pose === 'down' || opponent.recover > EPSILON ||
      !inRange(fighter, opponent, move.reach, move.depth)) return null;
  if (attack.name === 'rush') {
    if (opponent.pose === 'block' || forwardOf(attack, opponent.x - fighter.x, opponent.z - fighter.z) < -3) return null;
    return { damage: move.damage, fall: false, push: { x: attack.x * 8, z: attack.z * 8 } };
  }
  if (attack.name === 'strike' && opponent.pose === 'block') return null;
  if ((opponent.x - fighter.x) * fighter.facing < -3) return null;
  if (attack.name === 'signature') {
    if (opponent.pose === 'block' && !move.grab) return null;
    return { damage: move.damage, grab: move.grab, signature: Boolean(move.grab), fall: move.fall, facing: fighter.facing,
      push: { x: fighter.facing * (move.fall ? 11 : 6), z: 0 } };
  }
  const hits = attack.hits || 0;
  if (attack.name === 'strike' && !againstReferee && fighter.health > 0) {
    fighter.combo = { hits: hits + 1, remaining: COMBO_WINDOW, queued: null };
  }
  const bonus = attack.name === 'throw' ? hits * 3 : hits * 2;
  return { damage: move.damage + bonus, facing: fighter.facing,
    grab: attack.name === 'throw' ? GRAPPLES[fighter.id].style : undefined, queued: attack.grabQueued };
}

function attackContact(fighter, opponent, referee) {
  const { attack } = fighter;
  if (!attack || attack.spent) return null;
  const move = attackTimeline(fighter);
  if (attack.time + EPSILON < move.impact) return null;
  attack.spent = true;
  if (attack.target !== 'referee') {
    const contact = groundContactWith(fighter, opponent, move);
    if (contact) return contact;
  }
  if (!canHitReferee(referee) || attack.name === 'shove') return null;
  const contact = groundContactWith(fighter, referee, move, true);
  return contact && { ...contact, referee: true, heavy: attack.name !== 'strike' };
}

function scaleAttack(fighter, attack) {
  if (!attack) return null;
  const power = powerFactor(fighter);
  return { ...attack, damage: impactDamage(attack.damage, power), power };
}

function addImpact(match, fighter, attack) {
  const { x: victimX, z: victimZ, height } = fighter;
  const direction = attack.push || { x: attack.facing, z: 0 };
  match.impacts.push({
    x: victimX - Math.sign(direction.x) * 3,
    z: victimZ - Math.sign(direction.z) * 2,
    height: attack.atMat ? height + 3 : height + 17,
    xDirection: Math.sign(direction.x), zDirection: Math.sign(direction.z),
    heavy: Boolean(attack.heavy || attack.fall || attack.corner || attack.atMat),
    at: match.elapsed, until: match.elapsed + IMPACT_DURATION
  });
}

function receiveAttack(match, fighter, attack) {
  fighter.combo = null;
  addImpact(match, fighter, attack);
  if (attack.corner) {
    const { x, z, side } = attack.corner;
    const target = matPoint(x + inward(side).x * 22, z + (z === 0 ? 9 : -9));
    fighter.corner = null;
    const motion = beginMotion(fighter, 'fall', target, 'mat', RING.height, 0.33);
    motion.corner = attack.corner;
    motion.damage = attack.damage;
    return;
  }
  const exhaustedBeforeHit = fighter.health === 0;
  fighter.health = Math.max(0, fighter.health - attack.damage);
  if (fighter.knockdown) {
    if (attack.aerial) fighter.knockdown.taps = Math.max(0, fighter.knockdown.taps - 2);
    return;
  }
  fighter.attack = null;
  fighter.lean = null;
  fighter.motion = null;
  fighter.rush = null;
  resetHeight(fighter);
  const fall = attack.fall || exhaustedBeforeHit;
  const push = attack.push || { x: attack.facing * (fall ? 9 : 3), z: 0 };
  Object.assign(fighter, surfacePoint(fighter, fighter.x + push.x * attack.power, fighter.z + push.z * attack.power));
  if (fall) knockDown(match, fighter);
  else {
    fighter.recover = 0.23;
    setPose(fighter, 'hit');
  }
}

function beginHold(match, index, contact) {
  const attacker = match.fighters[index];
  const defender = match.fighters[1 - index];
  match.hold = {
    index, contact, phase: 'clinch', elapsed: 0, duration: CLINCH_LIMIT,
    escape: 0, needed: escapePresses(defender.health), nextBotTap: 0.24, queued: !!contact.queued
  };
  defender.facing = -attacker.facing;
  for (const fighter of [attacker, defender]) {
    fighter.attack = null;
    fighter.rush = null;
    fighter.lean = null;
    fighter.motion = null;
    fighter.combo = null;
  }
  Object.assign(defender, surfacePoint(defender, attacker.x + attacker.facing * 11, attacker.z + 1));
  resetHeight(attacker);
  resetHeight(defender);
  setPose(attacker, 'clinch');
  setPose(defender, 'held');
}

function pulse(state, interval, elapsed = state.elapsed) {
  const taps = Math.max(0, Math.floor((elapsed - state.nextBotTap + EPSILON) / interval) + 1);
  state.nextBotTap += taps * interval;
  return taps;
}

function updateKnockdowns(match, previous, playerTaps) {
  const knockedOut = [];
  for (const [index, fighter] of match.fighters.entries()) {
    const down = fighter.knockdown;
    if (!down || down !== previous[index]) continue;
    const now = Math.min(match.elapsed, down.deadline);
    if (index === 1) {
      down.taps += pulse(down, down.botTapInterval, now - down.startedAt);
    } else if (match.elapsed <= down.deadline + EPSILON) {
      down.taps += Number(playerTaps || 0);
    }
    if (down.taps >= down.needed) startRise(fighter);
    else if (match.elapsed + EPSILON >= down.deadline) knockedOut.push(index);
  }
  if (knockedOut.length) {
    match.end = { winner: knockedOut.length === 2 ? null : 1 - knockedOut[0], reason: 'knockout' };
  }
}

function releaseHold(match, attacker, defender) {
  match.hold = null;
  for (const fighter of [attacker, defender]) {
    resetHeight(fighter);
    fighter.recover = 0.18;
    setPose(fighter, 'idle');
  }
}

function updateHold(match, command, dt) {
  const hold = match.hold;
  const attacker = match.fighters[hold.index];
  const defender = match.fighters[1 - hold.index];
  hold.elapsed += dt;
  ageFighter(attacker, dt);
  ageFighter(defender, dt);
  const grapple = GRAPPLES[attacker.id];
  if (hold.phase === 'clinch') {
    hold.escape += hold.index === 1 ? Number(command.pin || 0) : pulse(hold, 0.20);
    if (hold.escape >= hold.needed || hold.elapsed + EPSILON >= CLINCH_LIMIT ||
        (hold.index === 1 && attacker.surface === 'floor' && match.outside.elapsed >= RINGSIDE_RETURN)) {
      releaseHold(match, attacker, defender);
      return;
    }
    if (hold.index === 0 && command.throw) hold.queued = true;
    const finishAt = hold.contact.signature ? SIGNATURE_CLINCH : hold.index === 1 ? BOT_CLINCH_FINISH :
      hold.queued ? CLINCH_WINDUP : Infinity;
    if (hold.elapsed + EPSILON < finishAt) return;
    hold.phase = 'throw';
    hold.elapsed = 0;
    const signature = SIGNATURES[attacker.id];
    hold.duration = hold.contact.signature ? signature.duration - signature.impact : grapple.duration;
    const style = hold.contact.grab;
    setPose(attacker, 'grappling');
    setPose(defender, 'caught' + style[0].toUpperCase() + style.slice(1));
    return;
  }
  const progress = clamp(hold.elapsed / hold.duration, 0, 1);
  const base = defender.surface === 'mat' ? RING.height : 0;
  defender.height = base + Math.sin(progress * Math.PI) * grapple.lift;
  if (progress + EPSILON < 1) return;
  match.hold = null;
  resetHeight(defender);
  receiveAttack(match, defender, { ...hold.contact, fall: true, atMat: true });
  attacker.recover = 0.32;
  setPose(attacker, 'land');
}

function placeHeldReferee(referee, attacker, progress = 0) {
  Object.assign(referee, matPoint(attacker.x + attacker.facing * (11 + 10 * progress), attacker.z + 1));
  referee.height = RING.height + Math.sin(progress * Math.PI) * GRAPPLES[attacker.id].lift;
  referee.facing = -attacker.facing;
}

function beginRefereeHold(match, index, contact) {
  const { referee } = match;
  const attacker = match.fighters[index];
  referee.interaction = {
    index, phase: 'clinch', elapsed: 0, duration: CLINCH_LIMIT, previousPhase: referee.phase,
    signature: Boolean(contact.signature), queued: Boolean(contact.queued)
  };
  referee.phase = 'held';
  referee.moving = false;
  attacker.attack = null;
  attacker.rush = null;
  attacker.combo = null;
  resetHeight(attacker);
  setPose(attacker, 'clinch');
  placeHeldReferee(referee, attacker);
}

function releaseRefereeInteraction(match) {
  const { referee } = match;
  const { index, previousPhase } = referee.interaction;
  referee.interaction = null;
  referee.phase = previousPhase;
  referee.height = RING.height;
  advanceReferee(referee, match.elapsed);
  const attacker = match.fighters[index];
  attacker.recover = 0.18;
  setPose(attacker, 'idle');
}

function updateRefereeInteraction(match, command, dt) {
  const { referee } = match;
  const interaction = referee.interaction;
  const attacker = match.fighters[interaction.index];
  ageFighter(attacker, dt);
  interaction.elapsed += dt;
  if (interaction.phase === 'pin') {
    if (interaction.elapsed + EPSILON >= interaction.duration) releaseRefereeInteraction(match);
    return;
  }
  if (interaction.phase === 'clinch') {
    placeHeldReferee(referee, attacker);
    interaction.queued ||= Boolean(command.throw) || interaction.index === 1;
    const windup = interaction.signature ? SIGNATURE_CLINCH : CLINCH_WINDUP;
    if ((interaction.signature || interaction.queued) && interaction.elapsed + EPSILON >= windup) {
      interaction.phase = 'throw';
      interaction.elapsed = 0;
      interaction.duration = interaction.signature
        ? SIGNATURES[attacker.id].duration - SIGNATURES[attacker.id].impact : GRAPPLES[attacker.id].duration;
      setPose(attacker, 'grappling');
    } else if (interaction.elapsed + EPSILON >= interaction.duration) {
      releaseRefereeInteraction(match);
    }
    return;
  }

  const progress = clamp(interaction.elapsed / interaction.duration, 0, 1);
  placeHeldReferee(referee, attacker, progress);
  if (progress < 1 - EPSILON) return;
  releaseRefereeInteraction(match);
  addImpact(match, referee, { fall: true, atMat: true, facing: attacker.facing });
  knockRefereeDown(referee, match.elapsed);
  attacker.recover = 0.32;
  setPose(attacker, 'land');
}

function contactReferee(match, index, contact, incoming) {
  const { referee } = match;
  if (!contact?.referee || !canHitReferee(referee)) return;
  if (contact.grab) {
    if (!incoming && !match.hold) beginRefereeHold(match, index, contact);
    return;
  }
  addImpact(match, referee, contact);
  hitReferee(referee, match.elapsed, contact.heavy);
}

function separate(fighters) {
  const [a, b] = fighters;
  if (!grounded(a) || !grounded(b) || a.surface !== b.surface ||
      a.pose === 'down' || b.pose === 'down' || Math.abs(a.z - b.z) >= 5) return;
  const delta = b.x - a.x;
  const space = 10 - Math.abs(delta);
  if (space <= 0) return;
  const direction = delta === 0 ? a.facing : Math.sign(delta);
  a.x = surfacePoint(a, a.x - direction * space / 2, a.z).x;
  b.x = surfacePoint(b, a.x + direction * 10, b.z).x;
  a.x = surfacePoint(a, b.x - direction * 10, a.z).x;
}

function measureSteps(fighters, from, intended) {
  const depthScale = WALK.x / WALK.z;
  fighters.forEach((fighter, index) => {
    if (fighter.pose !== 'walk' || fighter.motion) return;
    const [x, z] = from[index];
    const dx = intended[index][0] - x;
    const dz = (intended[index][1] - z) * depthScale;
    const distance = Math.hypot(dx, dz);
    if (distance <= EPSILON) return;
    const advanced = (dx * (fighter.x - x) + dz * (fighter.z - z) * depthScale) / distance;
    fighter.strideDistance += clamp(advanced, 0, distance);
  });
}

function steer(fighter, target, reachX = 2, reachZ = 2) {
  const dx = target.x - fighter.x;
  const dz = target.z - fighter.z;
  return { x: Math.abs(dx) > reachX ? Math.sign(dx) : 0, z: Math.abs(dz) > reachZ ? Math.sign(dz) : 0 };
}

function routeOnFloor(fighter, target) {
  if (target.z >= FLOOR.threshold) return target;
  const otherSide = (fighter.x < 0) !== (target.x < 0);
  if (fighter.z < FLOOR.threshold && otherSide) return { x: fighter.x, z: FLOOR.threshold + 4 };
  if (fighter.z >= FLOOR.threshold && otherSide) return { x: target.x, z: fighter.z };
  return target;
}

function ringsideEntry(fighter, player, gate) {
  if (inRange(fighter, gate.floor, 5, 4)) return { interact: true };
  const target = routeOnFloor(fighter, gate.floor);
  const towardGate = Math.sign(target.x - fighter.x);
  if (gate.floor.z < FLOOR.threshold && player.surface === 'floor' &&
      Math.abs(player.z - fighter.z) < 7 && (player.x - fighter.x) * towardGate > 0 &&
      Math.abs(player.x - gate.floor.x) < 11) {
    const behind = player.z - 9;
    const ahead = player.z + 9;
    const canGoBehind = behind >= 14;
    const z = canGoBehind && (ahead > RING.depth - 14 || fighter.z <= player.z) ? behind : ahead;
    return steer(fighter, { x: fighter.x, z });
  }
  return steer(fighter, target);
}

function retreatTarget(fighter, player) {
  const away = Math.sign(fighter.x - player.x) || fighter.facing;
  const x = clamp(fighter.x + away * 23, 16, RING.width - 16);
  if ((x - fighter.x) * away >= 10) return matPoint(x, fighter.z);
  const awayDepth = Math.sign(fighter.z - player.z) || (player.z < RING.depth / 2 ? 1 : -1);
  const z = clamp(fighter.z + awayDepth * 16, 8, RING.depth - 8);
  return matPoint(fighter.x, z);
}

function cornerAttack(corner, player) {
  if (!grounded(player) || player.surface !== 'mat') return null;
  const x = inward(corner.side).x;
  const z = corner.z === 0 ? 1 : -1;
  const progress = player.pose === 'down' ? 0.96 : 0.85;
  return [{ x, z }, { x, z: 0 }, { x: 0, z }].find((direction) => {
    const { target } = cornerLanding(corner, direction.x, direction.z);
    return inRange(player, {
      x: corner.x + (target.x - corner.x) * progress,
      z: corner.z + (target.z - corner.z) * progress
    }, 19, 8);
  });
}

function startGuard(match) {
  const fighter = match.fighters[1];
  const target = fighter.surface === 'mat' ? BOT_HOME[match.bot.style] : { x: fighter.x, z: fighter.z };
  match.bot.plan = { name: 'guard', target, until: match.elapsed + BOT_GUARD_TIME };
}

function pickBotPlan(match) {
  const [player, fighter] = match.fighters;
  const bot = match.bot;
  const target = player.surface === 'mat' ? matPoint(player.x, player.z) : { x: player.x, z: player.z };
  const options = [{ name: 'approach', weight: 5, target }];
  if (fighter.surface === 'mat' && !fighter.lean && bot.cooldown < 1) {
    const side = fighter.x < RING.width / 2 ? 'left' : 'right';
    const ropeX = side === 'left' ? 6 : RING.width - 6;
    const normal = inward(side).x;
    const gap = (player.x - ropeX) * normal;
    if (Math.abs(ropeX - fighter.x) <= 36 && gap >= 22 && gap <= 69 &&
        Math.abs(player.z - fighter.z) <= 10 && fighter.z >= 12 && fighter.z <= RING.depth - 12) {
      options.push({ name: 'rush', weight: 2, side, ropeX, z: fighter.z });
    }
    const corner = CORNERS.find((point) => walkDistance(fighter, point) <= 37 && cornerAttack(point, player));
    if (corner) options.push({ name: 'corner', weight: 2, corner });
    if (inRange(fighter, player, 23, 11)) {
      options.push({ name: 'retreat', weight: 2, target: retreatTarget(fighter, player) });
    }
    if (canTaunt(fighter) && walkDistance(fighter, player) >= 34) {
      options.push({ name: 'taunt', weight: 2 });
    }
  }
  const weight = (option) => option.weight + (option.name === bot.style ? 7 : 0);
  let roll = bot.random() * options.reduce((sum, option) => sum + weight(option), 0);
  let choice = options[0];
  for (const option of options) {
    roll -= weight(option);
    if (roll < 0) {
      choice = option;
      break;
    }
  }
  const duration = choice.name === 'rush' ? 1.45 : BOT_APPROACH_TIME;
  bot.plan = { ...choice, until: match.elapsed + duration };
}

function ropePlanCommand(match, plan) {
  const [player, fighter] = match.fighters;
  const bot = match.bot;
  const normal = inward(plan.side).x;
  if (fighter.lean === plan.side) {
    if (fighter.age < 0.18) return { x: -normal };
    plan.released = true;
  }
  if (fighter.lean === plan.side || fighter.rush) {
    const forward = (player.x - fighter.x) * normal;
    const ready = fighter.lean ? forward <= 47 : forward <= 31;
    if (ready && forward >= 3 && Math.abs(player.z - fighter.z) <= 8 && grounded(player)) {
      startGuard(match);
      bot.cooldown = 0.83;
      return { x: normal, strike: true };
    }
    return { x: normal };
  }
  if (plan.released) {
    startGuard(match);
    return null;
  }
  return Math.abs(fighter.z - plan.z) > 2
    ? steer(fighter, { x: plan.ropeX, z: plan.z })
    : { x: -normal };
}

function botDefense(match) {
  const [player, fighter] = match.fighters;
  const bot = match.bot;
  const attack = player.attack;
  const blockable = attack && (attack.name === 'strike' || attack.name === 'rush' ||
    (attack.name === 'signature' && !SIGNATURES[player.id].grab));
  if (!blockable ||
      attack.spent || attack.time < 0.06 || !inRange(fighter, player, 29, 9)) return null;
  if (bot.observedAttack !== attack) {
    bot.observedAttack = attack;
    bot.defending = bot.random() < (bot.style === 'grapple' ? 0.55 : 0.4);
  }
  if (!bot.defending) return null;
  bot.counter = match.elapsed + 0.36;
  return { block: true };
}

function botAttack(match) {
  const [player, fighter] = match.fighters;
  const bot = match.bot;
  if (!inRange(fighter, player, 22, 7) || player.recover > EPSILON || !grounded(player) ||
      (bot.cooldown > EPSILON && bot.counter <= match.elapsed)) return null;
  const signature = SIGNATURES[fighter.id];
  if (canUseSignature(fighter) && inRange(fighter, player, signature.reach, signature.depth) &&
      (player.pose !== 'block' || signature.grab) &&
      bot.random() >= (bot.style === 'grapple' ? 0.78 : 0.67)) {
    bot.counter = 0;
    bot.cooldown = signature.duration + 0.4;
    startGuard(match);
    return { signature: true };
  }
  const shouldThrow = player.pose === 'block' || bot.random() < (bot.style === 'grapple' ? 0.66 : 0.25);
  if (shouldThrow && !inRange(fighter, player, ATTACKS.throw.reach, ATTACKS.throw.depth)) {
    if (player.pose === 'block') return null;
    bot.cooldown = 0.83;
    startGuard(match);
    return { strike: true };
  }
  bot.counter = 0;
  bot.cooldown = shouldThrow ? 1.10 : 0.83;
  startGuard(match);
  return shouldThrow ? { throw: true } : { strike: true };
}

function botComboCommand(match, fighter) {
  if (!fighter.combo || fighter.attack.checkedFollowUp ||
      attackTimeline(fighter).duration - fighter.attack.time > COMBO_BUFFER) return {};
  fighter.attack.checkedFollowUp = true;
  if (match.bot.random() > 0.50) return {};
  const player = match.fighters[0];
  if (inRange(fighter, player, 16, 7) &&
      (fighter.combo.hits === 2 || match.bot.style === 'grapple')) return { throw: true };
  return fighter.combo.hits === 1 && inRange(fighter, player, 21, 8) ? { strike: true } : {};
}

function refereeBotInput(match) {
  const { referee, bot } = match;
  const [player, fighter] = match.fighters;
  const bothOnMat = fighter.surface === 'mat' && player.surface === 'mat';
  if (referee.interaction?.index === 0 && bothOnMat) {
    bot.refereePlan = null;
    return botAttack(match) || steer(fighter, player, 15, 5);
  }

  const playerInReach = inRange(fighter, player, STRIKE.reach, STRIKE.depth);
  if (match.elapsed + EPSILON >= bot.nextRefereeAttempt) {
    bot.nextRefereeAttempt = (Math.floor((match.elapsed + EPSILON) / REFEREE_BOT_INTERVAL) + 1) * REFEREE_BOT_INTERVAL;
    if (bothOnMat && !playerInReach && referee.phase === 'standing' && bot.random() < REFEREE_BOT_CHANCE) {
      bot.refereePlan = { move: bot.random() < 0.5 ? 'throw' : 'strike', until: match.elapsed + 3 };
      bot.plan = null;
    }
  }
  const plan = bot.refereePlan;
  if (!plan) return null;
  if (!bothOnMat || playerInReach || !canHitReferee(referee) || match.elapsed >= plan.until) {
    bot.refereePlan = null;
    return null;
  }
  const { reach, depth } = ATTACKS[plan.move];
  if (!inRange(fighter, referee, reach, depth)) return steer(fighter, referee, reach - 4, depth - 3);
  if (bot.cooldown > EPSILON) return {};
  bot.cooldown = plan.move === 'throw' ? 1.1 : 0.6;
  return { [plan.move]: true, target: 'referee' };
}

function chooseFollowUp(match, fighter, player) {
  const remaining = player.knockdown.deadline - match.elapsed;
  const options = [];
  const vulnerable = player.health === 0 || (player.health <= 30 && !canReachRopes(player));
  if (vulnerable && !refereeHasLeft(match.referee) && canPin(match, 1)) options.push({ kind: 'pin' });

  if (!fighter.corner && !fighter.lean && remaining >= GROUND_JUMP_TIME) {
    const travel = GROUND_JUMP_TIME * speedFactor(fighter);
    const x = (player.x - fighter.x) / (WALK.x * travel);
    const z = (player.z - fighter.z) / (WALK.z * travel);
    if (inRange(groundJumpTarget(fighter, x, z), player, 23, 10)) options.push({ kind: 'jump', x, z });
  }

  if (fighter.surface === 'mat') {
    let closest;
    let fastest = remaining;
    for (const corner of fighter.corner ? [fighter.corner] : CORNERS) {
      const direction = cornerAttack(corner, player);
      if (!direction) continue;
      const landing = cornerLanding(corner, direction.x, direction.z);
      const approach = fighter.corner ? 0 : CORNER_CLIMB_TIME +
        walkDistance(fighter, matPoint(corner.x, corner.z)) / (WALK.x * speedFactor(fighter));
      const time = approach + BOT_DIVE_DELAY + landing.duration;
      if (time > fastest) continue;
      closest = corner;
      fastest = time;
    }
    if (closest) options.push({ kind: 'corner', corner: closest });
  }
  if (!options.length) return { kind: 'wait' };
  return options[Math.floor(match.bot.random() * options.length)];
}

function botFollowUp(match, fighter, player) {
  const { knockdown } = player;
  if (match.elapsed - knockdown.startedAt + EPSILON < BOT_FOLLOW_UP_DELAY || match.bot.cooldown > EPSILON) return {};
  knockdown.followUp ??= chooseFollowUp(match, fighter, player);
  const plan = knockdown.followUp;
  switch (plan.kind) {
    case 'pin':
      knockdown.followUp = { kind: 'wait' };
      return { pin: true };
    case 'jump':
      knockdown.followUp = { kind: 'wait' };
      return { x: plan.x, z: plan.z, jump: true, strike: true };
    case 'corner': {
      if (!fighter.corner) {
        if (nearCorner(fighter) === plan.corner) return { interact: true };
        return steer(fighter, matPoint(plan.corner.x, plan.corner.z));
      }
      if (fighter.age + EPSILON < BOT_DIVE_DELAY) return {};
      knockdown.followUp = { kind: 'wait' };
      const direction = cornerAttack(fighter.corner, player);
      if (direction && match.elapsed + cornerLanding(fighter.corner, direction.x, direction.z).duration <= knockdown.deadline) {
        return { ...direction, jump: true, strike: true };
      }
      return { interact: true };
    }
    default:
      return fighter.corner ? { interact: true } : {};
  }
}

function botInput(match, dt) {
  const [player, fighter] = match.fighters;
  const bot = match.bot;
  bot.cooldown = Math.max(0, bot.cooldown - dt);
  if (match.outside.elapsed === 0) bot.ringsideGate = undefined;

  if (fighter.attack) return botComboCommand(match, fighter);
  if (fighter.knockdown || fighter.recover > EPSILON || fighter.motion || fighter.pose === 'taunt') return {};
  const returning = fighter.surface === 'floor' && match.outside.elapsed >= RINGSIDE_RETURN;
  if (player.knockdown && fighter.health > 0 && fighter.surface === player.surface && !returning) {
    return botFollowUp(match, fighter, player);
  }
  if (fighter.corner) {
    if (fighter.health === 0) return { interact: true };
    const direction = cornerAttack(fighter.corner, player);
    if (!direction) return { interact: true };
    if (fighter.age < BOT_DIVE_DELAY) return {};
    startGuard(match);
    bot.cooldown = 0.83;
    return { ...direction, jump: true, strike: true };
  }
  if (fighter.health > 0) {
    const refereeCommand = refereeBotInput(match);
    if (refereeCommand) return refereeCommand;
  }
  if (fighter.surface === 'floor' && player.surface === 'floor') bot.ringsideGate = null;
  if (fighter.surface !== player.surface || returning) {
    bot.plan = null;
    if (fighter.surface === 'mat') {
      if (bot.ringsideGate === undefined) {
        if (match.outside.elapsed < 0.35) return {};
        const gate = routeToGate(fighter, player);
        const exitTime = walkDistance(fighter, gate.mat) / (WALK.x * speedFactor(fighter)) + 0.36;
        bot.ringsideGate = match.outside.elapsed + exitTime < RINGSIDE_RETURN - 0.65 ? gate : null;
      }
      const gate = bot.ringsideGate;
      if (gate && match.outside.elapsed < RINGSIDE_RETURN - 0.65) {
        return inRange(fighter, gate.mat, 5, 4) ? { interact: true } : steer(fighter, gate.mat);
      }
      return steer(fighter, BOT_HOME[bot.style]);
    }
    bot.ringsideGate = null;
    const gate = routeToGate(fighter, fighter);
    return ringsideEntry(fighter, player, gate);
  }
  if (fighter.health === 0) {
    if (player.pose !== 'down' && grounded(player) && player.recover <= EPSILON &&
        bot.cooldown <= EPSILON && fighter.weakStrikeCooldown <= EPSILON &&
        inRange(fighter, player, STRIKE.reach, STRIKE.depth)) {
      return { strike: true };
    }
    return steer(fighter, retreatTarget(fighter, player));
  }
  if (player.pose === 'perch' && player.corner) {
    bot.plan = null;
    if (player.age < PERCH_DELAY) return {};
    if (inRange(fighter, player, ATTACKS.shove.reach, ATTACKS.shove.depth)) {
      if (bot.cooldown > 0) return {};
      bot.cooldown = 0.8;
      return { shove: true };
    }
    const { x, z, side } = player.corner;
    return steer(fighter, matPoint(x + inward(side).x * 13, z + (z === 0 ? 7 : -7)));
  }
  if (player.pose === 'down') return {};
  const defense = botDefense(match);
  if (defense) return defense;
  if (bot.counter > match.elapsed) return botAttack(match) || {};
  if (!bot.plan || match.elapsed >= bot.plan.until) {
    if (bot.plan && bot.plan.name !== 'guard') startGuard(match);
    else pickBotPlan(match);
  }
  const plan = bot.plan;
  switch (plan.name) {
    case 'taunt':
      startGuard(match);
      return { taunt: true };
    case 'retreat':
      if (!inRange(fighter, plan.target, 3, 3)) return steer(fighter, plan.target);
      startGuard(match);
      return {};
    case 'rush': {
      const command = ropePlanCommand(match, plan);
      if (command) return command;
      return {};
    }
    case 'corner': {
      const { corner } = plan;
      if (cornerAttack(corner, player)) {
        if (nearCorner(fighter) === corner) return { interact: true };
        return steer(fighter, matPoint(corner.x, corner.z));
      }
      startGuard(match);
      return {};
    }
    case 'approach': {
      const attack = botAttack(match);
      if (attack) return attack;
      const target = fighter.surface === 'floor' ? routeOnFloor(fighter, plan.target) : plan.target;
      const command = steer(fighter, target, 14, 4);
      if (command.x || command.z) return command;
      startGuard(match);
      return {};
    }
    default: {
      const attack = botAttack(match);
      if (attack) return attack;
      if (inRange(fighter, player, 25, 9)) return {};
      return steer(fighter, plan.target, 3, 3);
    }
  }
}

function moveReferee(match, target, dt) {
  const ref = match.referee;
  if (!canRefereeCount(ref) || dt <= EPSILON) return;
  if (!target) {
    walkRefereeAroundFighters(ref, match.fighters, dt);
    return;
  }
  const offset = match.pin ? (target.x > RING.width / 2 ? -37 : 37) : 0;
  const x = clamp(target.x + offset, 14, RING.width - 14);
  const z = clamp(target.z - 11, 3, RING.depth - 7);
  const speed = 82 * dt;
  ref.moving = Math.abs(x - ref.x) + Math.abs(z - ref.z) > 0.7;
  if (Math.abs(target.x - ref.x) > 0.7) ref.facing = target.x > ref.x ? 1 : -1;
  ref.x += clamp(x - ref.x, -speed, speed);
  ref.z += clamp(z - ref.z, -speed, speed);
}

function updateRopes(match, dt) {
  for (const [edge, rope] of Object.entries(match.ropes)) {
    const contact = match.fighters.find((fighter) => fighter.lean === edge);
    if (contact) {
      rope.position = clamp(contactAlong(edge, contact), 0.08, 0.92);
      rope.flex = Math.min(1, rope.flex + 5.6 * dt);
    } else {
      rope.flex = Math.max(0, rope.flex - 4.8 * dt);
    }
  }
}

export function canPin(match, index) {
  const attacker = match.fighters[index];
  const defender = match.fighters[1 - index];
  return attacker.health > 0 && !match.hold && match.referee.interaction?.index !== index &&
    attacker.surface === 'mat' && defender.surface === 'mat' && canAct(attacker) &&
    defender.pose === 'down' && inRange(attacker, defender, 22, 12);
}

export function canPinReferee(match, index) {
  const { referee } = match;
  const attacker = match.fighters[index];
  return referee.phase === 'down' && !referee.interaction && !match.hold && !match.pin &&
    attacker.health > 0 && attacker.surface === 'mat' && canAct(attacker) && inRange(attacker, referee, 22, 12);
}

function beginRefereePin(match, index) {
  if (!canPinReferee(match, index)) return;
  const { referee } = match;
  const attacker = match.fighters[index];
  setFacing(attacker, referee);
  Object.assign(attacker, matPoint(referee.x - attacker.facing * 8, referee.z));
  attacker.lean = null;
  attacker.rush = null;
  attacker.combo = null;
  setPose(attacker, 'pin');
  referee.interaction = { index, phase: 'pin', previousPhase: 'down', elapsed: 0, duration: REFEREE_PIN_TIME };
}

export function canReachRopes(fighter) {
  return fighter.surface === 'mat' &&
    (fighter.x <= 18 || fighter.x >= RING.width - 18 || fighter.z <= 7 || fighter.z >= RING.depth - 7);
}

function beginPin(match, index) {
  if (!canPin(match, index)) return;
  const attacker = match.fighters[index];
  const defender = match.fighters[1 - index];
  setFacing(attacker, defender);
  attacker.x = clamp(defender.x - attacker.facing * 8, 5, RING.width - 5);
  attacker.z = defender.z;
  attacker.lean = null;
  attacker.rush = null;
  attacker.combo = null;
  defender.combo = null;
  defender.knockdown = null;
  setPose(attacker, 'pin');
  match.pinBreak = null;
  const resistance = clamp((defender.health - 20) / 80, 0, 1);
  const botTapInterval = BOT_PIN_TAP_INTERVAL - (index === 0 ? 0.28 * resistance : 0);
  match.pin = {
    attacker: index, elapsed: 0, paused: 0, count: 0, pressure: 1,
    needed: escapeThreshold(defender.health, 32, 8),
    pressurePerTap: PIN_PRESSURE_PER_TAP * (1 - 0.60 * resistance),
    botTapInterval, nextBotTap: botTapInterval
  };
}

function updatePin(match, command, dt, refereeDt) {
  const pin = match.pin;
  const attacker = match.fighters[pin.attacker];
  const defender = match.fighters[1 - pin.attacker];
  pin.elapsed += dt;
  ageFighter(attacker, dt);
  ageFighter(defender, dt);
  const playerTaps = Number(command.pin || 0);
  const botTaps = pulse(pin, pin.botTapInterval);
  const applyPressure = pin.attacker === 0 ? playerTaps : botTaps;
  const resist = pin.attacker === 1 ? playerTaps : botTaps;
  pin.pressure = clamp(pin.pressure - dt / PIN_RELEASE_TIME +
    applyPressure * pin.pressurePerTap - resist / pin.needed, 0, 1);
  moveReferee(match, defender, refereeDt);

  const ropeBreak = canReachRopes(defender) &&
    (pin.attacker === 1 ? command.ropeBreak || command.block : pin.elapsed >= 0.37);
  const freshBotEscaped = pin.attacker === 0 && defender.health >= FRESH_DEFENDER_HEALTH &&
    pin.elapsed + EPSILON >= FRESH_BOT_KICK_OUT_TIME;
  if (ropeBreak || freshBotEscaped || pin.pressure <= EPSILON) {
    releasePin(match, ropeBreak ? 'rope' : 'escape');
    return;
  }

  const counting = canRefereeCount(match.referee);
  pin.paused += counting ? dt - refereeDt : dt;
  if (!counting) {
    if (refereeHasLeft(match.referee)) pin.count = 0;
    return;
  }
  pin.count = Math.min(3, Math.floor(pin.elapsed - pin.paused + EPSILON));
  if (pin.count === 3) match.end = { winner: pin.attacker, reason: 'pin' };
}

function releasePin(match, reason) {
  const { attacker } = match.pin;
  setPose(match.fighters[attacker], 'idle');
  const defender = match.fighters[1 - attacker];
  startRise(defender);
  match.pin = null;
  match.pinBreak = reason;
  match.bot.cooldown = 0.65;
}

function updateOutside(match, dt, refereeDt) {
  const outside = match.fighters.filter((fighter) => fighter.surface === 'floor');
  if (!outside.length) {
    match.outside.elapsed = 0;
    match.outside.paused = 0;
    match.outside.count = 0;
    return null;
  }
  match.outside.elapsed += dt;
  const counting = canRefereeCount(match.referee);
  match.outside.paused += counting ? dt - refereeDt : dt;
  if (!counting) {
    if (refereeHasLeft(match.referee)) match.outside.count = 0;
    return outside[0];
  }
  match.outside.count = Math.min(OUTSIDE_COUNT, Math.floor(match.outside.elapsed - match.outside.paused + EPSILON));
  if (match.outside.count === OUTSIDE_COUNT) {
    const draw = outside.length === match.fighters.length;
    match.end = {
      winner: draw ? null : match.fighters.findIndex((fighter) => fighter.surface === 'mat'),
      reason: draw ? 'double-countout' : 'countout'
    };
  }
  return outside[0];
}

function resolveContacts(match, contacts) {
  const [player, bot] = match.fighters;
  const fighterAttacks = contacts.map((contact, index) =>
    contact?.referee ? null : scaleAttack(match.fighters[index], contact));
  const [playerAttack, botAttack] = fighterAttacks;
  const interaction = match.referee.interaction;
  if (interaction && fighterAttacks[1 - interaction.index]) releaseRefereeInteraction(match);

  if (playerAttack?.grab && !botAttack) beginHold(match, 0, playerAttack);
  else if (botAttack?.grab && !playerAttack) beginHold(match, 1, botAttack);
  else {
    if (playerAttack && !playerAttack.grab) receiveAttack(match, bot, playerAttack);
    if (botAttack && !botAttack.grab) receiveAttack(match, player, botAttack);
  }
  contacts.forEach((contact, index) => contactReferee(match, index, contact, fighterAttacks[1 - index]));
}

export function stepMatch(match, command = {}, dt = STEP) {
  if (match.end) return;
  const { referee } = match;
  if (refereeHasLeft(referee) || (!match.pin && !match.hold)) dt = Math.min(match.clock, dt);
  match.elapsed += dt;
  match.clock = Math.max(0, match.clock - dt);
  if (match.clock < EPSILON) match.clock = 0;
  // A step that crosses the end of the stagger only moves the referee for the time left in that step.
  const refereeDt = referee.phase === 'staggered' ? clamp(match.elapsed - referee.until, 0, dt) : dt;
  advanceReferee(referee, match.elapsed);
  if (match.impacts.length) {
    match.impacts = match.impacts.filter((impact) => impact.until > match.elapsed + EPSILON);
  }

  if (match.pin) {
    updatePin(match, command, dt, refereeDt);
  } else if (match.hold) {
    updateHold(match, command, dt);
  } else {
    const interaction = referee.interaction;
    const cpuCommand = interaction?.index === 1 ? {} : botInput(match, dt);
    const [player, bot] = match.fighters;
    const previousKnockdowns = [player.knockdown, bot.knockdown];
    const start = match.fighters.map(({ x, z }) => [x, z]);
    const playerJump = interaction?.index === 0 ? null : advanceWrestler(match, player, bot, command, dt, 'nearest');
    const botJump = interaction?.index === 1 ? null : advanceWrestler(match, bot, player, cpuCommand, dt, cpuCommand.target || 'opponent');
    const playerAirHit = playerJump && jumpContact(player, bot, referee, playerJump);
    const botAirHit = botJump && jumpContact(bot, player, referee, botJump);
    const intended = match.fighters.map(({ x, z }) => [x, z]);
    separate(match.fighters);
    measureSteps(match.fighters, start, intended);
    resolveContacts(match, [
      playerAirHit || attackContact(player, bot, referee), botAirHit || attackContact(bot, player, referee)
    ]);
    if (interaction && referee.interaction === interaction) {
      updateRefereeInteraction(match, interaction.index === 0 ? command : cpuCommand, dt);
    }
    updateKnockdowns(match, previousKnockdowns, command.pin);
    if (!match.end && match.clock > 0) {
      const wantsPin = command.pin && !previousKnockdowns[0];
      if (wantsPin) beginPin(match, 0);
      if (!match.pin && cpuCommand.pin) beginPin(match, 1);
      if (!match.pin && wantsPin) beginRefereePin(match, 0);
    }
  }
  if (!match.pin && !match.end) {
    const outside = updateOutside(match, dt, refereeDt);
    moveReferee(match, outside, refereeDt);
    if (match.end && match.hold) releaseHold(match, ...match.fighters);
  }
  updateRopes(match, dt);
  match.crowdTime += dt * (match.fighters.some((fighter) => fighter.pose === 'taunt') ? 1.65 : 1);

  if (match.end || match.clock !== 0) return;
  if (refereeHasLeft(referee)) {
    const [player, bot] = match.fighters;
    const winner = player.health === bot.health ? null : player.health > bot.health ? 0 : 1;
    match.end = { winner, reason: 'stamina' };
    if (match.pin) releasePin(match, 'time');
    if (match.hold) releaseHold(match, player, bot);
  } else if (!match.pin && !match.hold) {
    if (referee.interaction) releaseRefereeInteraction(match);
    match.end = { winner: null, reason: 'time' };
  }
}
