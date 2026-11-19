export const RING = { width: 200, depth: 56, height: 28, cornerHeight: 25 };
export const FLOOR = { side: 32, apron: 10, back: 5, front: 103, threshold: 65 };

export const EDGES = ['left', 'right', 'back', 'front'];
export const CORNERS = [
  { x: 0, z: 0, side: 'left' },
  { x: RING.width, z: 0, side: 'right' },
  { x: 0, z: RING.depth, side: 'left' },
  { x: RING.width, z: RING.depth, side: 'right' }
];

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function matPoint(x, z) {
  return { x: clamp(x, 6, RING.width - 6), z: clamp(z, 2, RING.depth - 2) };
}

export function floorPoint(x, z, origin) {
  x = clamp(x, -FLOOR.side, RING.width + FLOOR.side);
  z = clamp(z, FLOOR.back, FLOOR.front);
  if (z < FLOOR.threshold && x > -FLOOR.apron && x < RING.width + FLOOR.apron) {
    if (origin.z >= FLOOR.threshold) z = FLOOR.threshold;
    else x = origin.x < 0 ? -FLOOR.apron : RING.width + FLOOR.apron;
  }
  return { x, z };
}

export function surfacePoint(fighter, x, z) {
  return fighter.surface === 'floor' ? floorPoint(x, z, fighter) : matPoint(x, z);
}

export function nearCorner(fighter) {
  return CORNERS.find(({ x, z }) => Math.abs(x - fighter.x) <= 13 && Math.abs(z - fighter.z) <= 8);
}

export function edgePressed(x, z, point) {
  if (x < point.x) return 'left';
  if (x > point.x) return 'right';
  if (z < point.z) return 'back';
  if (z > point.z) return 'front';
  return null;
}

export function contactAlong(edge, fighter) {
  return edge === 'left' || edge === 'right' ? fighter.z / RING.depth : fighter.x / RING.width;
}

export function inward(edge) {
  switch (edge) {
    case 'left': return { x: 1, z: 0 };
    case 'right': return { x: -1, z: 0 };
    case 'back': return { x: 0, z: 1 };
    default: return { x: 0, z: -1 };
  }
}

export function gatesNear({ x, z }) {
  const alongSide = clamp(z, 14, RING.depth - 14);
  const alongFront = clamp(x, 22, RING.width - 22);
  return [
    { mat: { x: 7, z: alongSide }, floor: { x: -13, z: alongSide } },
    { mat: { x: RING.width - 7, z: alongSide }, floor: { x: RING.width + 13, z: alongSide } },
    { mat: { x: alongFront, z: RING.depth - 3 }, floor: { x: alongFront, z: FLOOR.threshold + 5 } }
  ];
}

export function walkDistance(a, b) {
  return Math.hypot(a.x - b.x, (a.z - b.z) * 1.55);
}
