import { RING, FLOOR, clamp } from './arena.mjs';
import { attackTimeline } from './match.mjs';
import { drawPixelText } from './pixel-text.mjs';
import { ROSTER } from './roster.mjs';

const asset = (name) => new URL(`assets/${name}`, import.meta.url);
const mix = (a, b, amount) => a + (b - a) * amount;
const ropeOffset = { left: [-9, 0], right: [9, 0], back: [0, -5], front: [0, 6] };

function loadImage(filename) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load ${filename}`));
    image.src = asset(filename);
  });
}

export async function loadArt() {
  const response = await fetch(asset('frames.json'));
  if (!response.ok) throw new Error('Unable to load sprite data');
  const { arenas, clips, strides } = await response.json();
  const entries = await Promise.all(Object.entries(arenas).map(async ([id, arena]) => {
    const [base, apron, crowd] = await Promise.all([
      loadImage(`${id}.png`),
      loadImage(`${id}-apron.png`),
      loadImage(`${id}-crowd.png`)
    ]);
    return [id, { ...arena, images: { base, apron, crowd } }];
  }));
  const [atlas, avatars] = await Promise.all([
    loadImage('wrestlers.png'),
    Promise.all(Object.keys(ROSTER).map(async (id) => {
      const portrait = await loadImage(`${id}-avatar.png`).catch(() => loadImage(`${id}-profile.png`));
      return [id, portrait.src];
    }))
  ]);
  return { arenas: Object.fromEntries(entries), clips, strides, atlas, avatars: Object.fromEntries(avatars) };
}

export function drawArenaBackdrop(ctx, arena, frame) {
  const { rect: [x, y, tileWidth, tileHeight], columns } = arena.crowd;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(arena.images.base, 0, 0);
  ctx.drawImage(arena.images.crowd,
    frame % columns * tileWidth, Math.floor(frame / columns) * tileHeight,
    tileWidth, tileHeight, x, y, tileWidth, tileHeight);
}

function project(arena, { x, z, height = RING.height }) {
  const [rearLeft, rearRight, frontLeft, frontRight] = arena.mat;
  const { inner, outer, height: apronHeight } = arena.ringside;
  const depth = clamp(z / RING.depth, 0, 1);
  const left = mix(rearLeft[0], frontLeft[0], depth);
  const right = mix(rearRight[0], frontRight[0], depth);
  let screenX = mix(left, right, clamp(x / RING.width, 0, 1));
  if (x < 0 || x > RING.width) {
    const side = x < 0 ? 0 : 1;
    const distance = x < 0 ? -x : x - RING.width;
    screenX = distance <= FLOOR.apron
      ? mix(screenX, inner[side], distance / FLOOR.apron)
      : mix(inner[side], outer[side], (distance - FLOOR.apron) / (FLOOR.side - FLOOR.apron));
  }
  const screenY = mix(rearLeft[1], frontLeft[1], depth) + Math.max(0, z - RING.depth) * 0.61 +
    apronHeight * (1 - height / RING.height);
  return [screenX, screenY];
}

function actorPosition(arena, actor) {
  const point = project(arena, actor);
  const corner = actor.corner || actor.motion?.corner;
  if (corner) {
    const edge = corner.z === 0 ? 'back' : 'front';
    const pad = arena.ropes[edge][0].points[corner.x === 0 ? 0 : 1];
    const original = project(arena, { ...corner, height: RING.height + RING.cornerHeight });
    const fraction = actor.corner
      ? clamp((actor.height - RING.height) / RING.cornerHeight, 0, 1)
      : 1 - actor.motion.elapsed / actor.motion.duration;
    point[0] += (pad[0] - original[0]) * fraction;
    point[1] += (pad[1] - original[1]) * fraction;
  }
  return point.map(Math.round);
}

function frameAt(clip, time, repeat) {
  if (clip.length === 1) return clip[0];
  const duration = clip.reduce((sum, frame) => sum + frame.duration, 0);
  let offset = repeat ? time % duration : Math.min(time, duration);
  for (const frame of clip) {
    if (offset + 1e-8 < frame.duration) return frame;
    offset -= frame.duration;
  }
  return clip.at(-1);
}

function drawRope(ctx, line, rope, edge) {
  const [[x0, y0], [x1, y1]] = line.points;
  if (rope.flex === 0 && y0 === y1) {
    ctx.fillStyle = line.colors[0];
    ctx.fillRect(x0, y0, x1 - x0 + 1, 1);
    if (line.colors.length > 1) {
      ctx.fillStyle = line.colors[1];
      for (let x = x0; x <= x1; x += 3) ctx.fillRect(x, y0, 1, 1);
    }
    return;
  }
  const [dx, dy] = ropeOffset[edge];
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  let previousX = x0;
  let previousY = y0;
  for (let i = 0; i <= steps; i += 1) {
    const along = i / steps;
    const tension = along < rope.position ? along / rope.position : (1 - along) / (1 - rope.position);
    const deflection = rope.flex * tension;
    const x = Math.round(mix(x0, x1, along) + dx * deflection);
    const y = Math.round(mix(y0, y1, along) + dy * deflection);
    ctx.fillStyle = line.colors[i % 3 === 0 ? line.colors.length - 1 : 0];
    ctx.fillRect(x, y, 1, 1);
    if (Math.abs(x - previousX) > 1 || Math.abs(y - previousY) > 1) {
      ctx.fillRect(Math.round((x + previousX) / 2), Math.round((y + previousY) / 2), 1, 1);
    }
    previousX = x;
    previousY = y;
  }
}

function isInFront(actor) {
  return actor.z > RING.depth + 1 || actor.pose === 'perch' || actor.height > RING.height + RING.cornerHeight;
}

function refereePose(match, presentation) {
  const { pin, outside, referee } = match;
  if (pin) {
    if (pin.count === 3 && presentation >= 0.14) return 'finish';
    if (pin.count > 0 && pin.elapsed - pin.count + presentation < 0.13) return 'slap';
    return 'ready';
  }
  if (outside.elapsed > 0 && (outside.count === 10 || outside.elapsed % 1 >= 0.66 ||
      (outside.count > 0 && outside.elapsed % 1 < 0.15))) return 'count';
  return referee.moving ? 'walk' : 'idle';
}

function poseTime(match, actor, strides) {
  const move = attackTimeline(actor);
  if (move) {
    const { impact, duration } = move;
    const time = actor.attack.time;
    return time < impact - 1e-8
      ? time / impact * 0.40
      : 0.40 + Math.max(0, time - impact) / (duration - impact) * 0.60;
  }
  if (match.hold && (actor.pose === 'grappling' || actor.pose.startsWith('caught'))) {
    return match.hold.elapsed / match.hold.duration;
  }
  if (actor.motion) return actor.motion.elapsed / actor.motion.duration;
  if (actor.pose === 'walk') return actor.strideDistance / (strides?.[actor.id] ?? 28);
  if (actor.recover > 0 && ['hit', 'rise', 'land'].includes(actor.pose)) {
    return actor.age / (actor.age + actor.recover);
  }
  return actor.age;
}

function worldContact(actor) {
  const [x, y] = actor.position;
  const { contact, pivot } = actor.frame;
  return [x + actor.facing * (contact[0] - pivot[0]), y + contact[1] - pivot[1]];
}

function alignHold(match, actors) {
  if (!match.hold) return;
  const { index, elapsed, duration } = match.hold;
  const lifter = actors[index];
  const partner = actors[1 - index];
  if (!lifter.frame.contact || !partner.frame.contact) return;
  const grip = worldContact(lifter);
  const held = worldContact(partner);
  const phase = elapsed / duration;
  if (match.hold.phase === 'clinch') {
    partner.position[0] += (grip[0] - held[0]) * Math.min(1, elapsed / 0.10);
    partner.position[0] = Math.round(partner.position[0]);
    return;
  }
  const weight = Math.min(1, phase / 0.14, (1 - phase) / 0.18);
  partner.position = partner.position.map((value, i) => Math.round(value + (grip[i] - held[i]) * weight));
}

export function createRenderer(canvas, art) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D is unavailable');

  function placeSprite(arena, actor) {
    const { name, pose, motion, gait, animationTime, repeat } = actor;
    const action = motion?.kind === 'rebound' ? 'rebound' : pose === 'walk' && gait === 'run' ? 'run' : pose;
    const sequence = art.clips[`${name}.${action}`];
    actor.frame = frameAt(sequence, animationTime, repeat && action !== 'rebound');
    actor.position = actorPosition(arena, actor);
  }

  function drawSprite(actor) {
    const [x, y] = actor.position;
    const frame = actor.frame;
    const [sx, sy, width, height] = frame.rect;
    const [anchorX, anchorY] = frame.pivot;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(actor.facing, 1);
    ctx.drawImage(art.atlas, sx, sy, width, height, -anchorX, -anchorY, width, height);
    ctx.restore();
  }

  function drawShadow(arena, actor) {
    if (actor.motion?.kind !== 'jump' && !(actor.pose === 'signature' && actor.height > RING.height)) return;
    const onMat = actor.x >= 0 && actor.x <= RING.width && actor.z >= 0 && actor.z <= RING.depth;
    const [x, z] = project(arena, { ...actor, height: onMat ? RING.height : 0 }).map(Math.round);
    ctx.fillStyle = '#080b1454';
    ctx.fillRect(x - 9, z - 1, 18, 2);
    ctx.fillRect(x - 7, z + 1, 14, 1);
  }

  function drawCount(arena, referee, count, isPin) {
    if (!count) return;
    const [refX, refY] = actorPosition(arena, referee);
    const center = clamp(refX + referee.facing * (isPin ? 15 : 22), 12, arena.size[0] - 12);
    const baseline = Math.max(8, refY - (isPin ? 26 : 41)) + 10;
    drawPixelText(ctx, String(count), center, baseline, 2);
  }

  function drawImpact(arena, impact, elapsed, reducedMotion) {
    const [x, y] = project(arena, impact).map(Math.round);
    const progress = clamp((elapsed - impact.at) / (impact.until - impact.at), 0, 1);
    const arms = reducedMotion ? 3 : Math.max(2, Math.round((impact.heavy ? 8 : 6) * (1 - progress)));
    ctx.fillStyle = '#fff6e9';
    ctx.fillRect(x - arms, y, arms * 2 + 1, 1);
    ctx.fillRect(x, y - arms, 1, arms * 2 + 1);
    ctx.fillRect(x - 1, y - 1, 3, 3);
    if (reducedMotion) return;
    const dx = impact.xDirection;
    const dy = impact.xDirection ? 0 : impact.zDirection;
    const travel = Math.round(progress * 9);
    for (const [along, across] of [[6, -4], [10, 3], [4, 6]]) {
      const sx = x + dx * (along + travel) - dy * across;
      const sy = y + dy * (along + travel) + dx * across;
      ctx.fillRect(sx, sy, dx ? 3 : 1, dx ? 1 : 3);
    }
  }

  return function draw(id, match, animateCrowd, { reducedMotion = false, presentation = 0, call = '' } = {}) {
    const arena = art.arenas[id];
    const [width, height] = arena.size;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const { frames, duration } = arena.crowd;
    const frame = animateCrowd ? Math.floor(match.crowdTime / duration) % frames : 0;
    drawArenaBackdrop(ctx, arena, frame);

    const actors = match.fighters.map((fighter, index) => ({
      ...fighter,
      name: fighter.id,
      animationTime: poseTime(match, fighter, art.strides),
      repeat: ['idle', 'walk', 'clinch', 'held'].includes(fighter.pose),
      depth: fighter.z + (match.pin?.attacker === index ? 0.05 : 0)
    }));
    const referee = {
      ...match.referee, name: 'ref', animationTime: match.elapsed, pose: refereePose(match, presentation),
      repeat: true, depth: match.referee.z
    };
    actors.push(referee);
    for (const actor of actors) placeSprite(arena, actor);
    alignHold(match, actors);
    actors.sort((a, b) => a.depth - b.depth);

    for (const actor of actors) drawShadow(arena, actor);
    const behindApron = (actor) => actor.surface === 'floor' && actor.z <= RING.depth &&
      actor.height < RING.height;
    for (const actor of actors) {
      if (behindApron(actor)) drawSprite(actor);
    }
    ctx.drawImage(arena.images.apron, ...arena.ringside.apron);
    for (const edge of ['back', 'left', 'right']) {
      for (const line of arena.ropes[edge]) drawRope(ctx, line, match.ropes[edge], edge);
    }
    for (const actor of actors) {
      if (!behindApron(actor) && !isInFront(actor)) drawSprite(actor);
    }
    for (const line of arena.ropes.front) drawRope(ctx, line, match.ropes.front, 'front');
    for (const actor of actors) {
      if (!behindApron(actor) && isInFront(actor)) drawSprite(actor);
    }
    for (const impact of match.impacts) {
      if (impact.until > match.elapsed + presentation) drawImpact(arena, impact, match.elapsed + presentation, reducedMotion);
    }
    drawCount(arena, referee, match.pin?.count ?? match.outside.count, Boolean(match.pin));
    if (call) drawPixelText(ctx, call, width / 2, Math.round(height * 0.47), 3);
  };
}
