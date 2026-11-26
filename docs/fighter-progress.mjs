import { clamp } from './arena.mjs';
import { canReachRopes } from './match.mjs';
import { canRefereeCount } from './referee.mjs';

const GAP = 4;

export function getFighterProgress(match, keys) {
  if (match.end) return null;
  const { pin, fighters, referee, elapsed } = match;
  if (pin) {
    const ropeHint = pin.attacker === 1 && canReachRopes(fighters[0]) ? `${keys.ropeBreak} · Grab rope` : '';
    return {
      kind: 'pin', fighter: 1 - pin.attacker, label: 'Pin pressure', role: 'meter',
      value: Math.ceil(pin.pressure * 100), max: 100, fill: pin.pressure,
      instruction: `Tap ${keys.pin} · ${pin.attacker === 0 ? 'Keep pin' : 'Kick out'}`,
      detail: [ropeHint, canRefereeCount(referee) ? '' : 'No count'].filter(Boolean).join(' · ')
    };
  }
  const { knockdown } = fighters[0];
  if (!knockdown) return null;
  const { taps, needed, deadline } = knockdown;
  const seconds = Math.max(0, Math.ceil(deadline - elapsed - 1e-8));
  return {
    kind: 'rise', fighter: 0, label: 'Get-up progress', role: 'progressbar', value: taps, max: needed,
    fill: taps / needed, instruction: `Tap ${keys.pin} · Get up`, detail: `${taps}/${needed} · ${seconds}s`,
    valueText: `${taps} of ${needed} taps, ${seconds} seconds left`
  };
}

export function containedRing(width, height, canvasWidth, canvasHeight) {
  const scale = Math.min(width / canvasWidth, height / canvasHeight);
  const fittedWidth = canvasWidth * scale;
  const fittedHeight = canvasHeight * scale;
  return { x: (width - fittedWidth) / 2, y: (height - fittedHeight) / 2,
    width: fittedWidth, height: fittedHeight, scale };
}

function toRingBox(ring, box) {
  const { scale } = ring;
  return { x: ring.x + box.x * scale, y: ring.y + box.y * scale,
    width: box.width * scale, height: box.height * scale };
}

export function progressPosition(ring, fighter, size, scoreboardBottom, count) {
  const sprite = toRingBox(ring, fighter);
  const left = ring.x + GAP;
  const top = Math.max(ring.y, scoreboardBottom) + GAP;
  const right = ring.x + ring.width - GAP;
  const bottom = ring.y + ring.height - GAP;
  const maxX = Math.max(left, right - size.width);
  const maxY = Math.max(top, bottom - size.height);
  const above = sprite.y - size.height - GAP;
  const below = sprite.y + sprite.height + GAP;
  const x = clamp(sprite.x + (sprite.width - size.width) / 2, left, maxX);
  const countBox = count && toRingBox(ring, count);
  const clearsCount = (x, y) => !countBox || x + size.width + GAP <= countBox.x ||
    x >= countBox.x + countBox.width + GAP || y + size.height + GAP <= countBox.y ||
    y >= countBox.y + countBox.height + GAP;

  for (const y of [above, below]) {
    if (y >= top && y <= maxY && clearsCount(x, y)) return { x, y };
  }
  const preferred = sprite.y - top >= bottom - sprite.y - sprite.height ? above : below;
  const y = clamp(preferred, top, maxY);
  if (clearsCount(x, y)) return { x, y };
  const alternateY = clamp(preferred === above ? below : above, top, maxY);
  if (clearsCount(x, alternateY)) return { x, y: alternateY };
  const toLeft = countBox.x - GAP - size.width;
  if (toLeft >= left) return { x: toLeft, y };
  const toRight = countBox.x + countBox.width + GAP;
  return { x: toRight <= maxX ? toRight : x, y };
}

export function createFighterProgress(root, canvas, scoreboard) {
  const instruction = root.querySelector('.fighter-progress-instruction');
  const detail = root.querySelector('.fighter-progress-detail');
  const meter = root.querySelector('.fighter-progress-meter');
  let ring;
  let scoreboardBottom;
  let canvasWidth;
  let canvasHeight;
  let size;
  let fill;
  let transform;

  function invalidateSize() {
    ring = null;
    size = null;
  }

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(invalidateSize);
    observer.observe(canvas);
    observer.observe(scoreboard);
    observer.observe(root);
  }
  window.addEventListener('resize', invalidateSize);

  function updateText(element, text) {
    if (element.textContent === text) return;
    element.textContent = text;
    element.hidden = !text;
    size = null;
  }

  function updateAttribute(name, value) {
    const text = String(value);
    if (meter.getAttribute(name) !== text) meter.setAttribute(name, text);
  }

  return {
    hide() { root.hidden = true; },
    show(progress, anchor, hintsEnabled) {
      if (!progress || !anchor) {
        root.hidden = true;
        return;
      }
      if (!ring || canvasWidth !== canvas.width || canvasHeight !== canvas.height) {
        const rect = canvas.getBoundingClientRect();
        canvasWidth = canvas.width;
        canvasHeight = canvas.height;
        ring = containedRing(rect.width, rect.height, canvasWidth, canvasHeight);
        scoreboardBottom = scoreboard.getBoundingClientRect().bottom - rect.top;
        root.style.setProperty('--progress-max-width', `${Math.max(0, ring.width - 2 * GAP)}px`);
        size = null;
      }
      if (ring.scale <= 0) {
        root.hidden = true;
        ring = null;
        return;
      }
      root.hidden = false;
      if (root.dataset.kind !== progress.kind) root.dataset.kind = progress.kind;
      updateAttribute('role', progress.role);
      updateAttribute('aria-label', progress.label);
      updateAttribute('aria-valuemax', progress.max);
      updateAttribute('aria-valuenow', progress.value);
      if (progress.valueText) updateAttribute('aria-valuetext', progress.valueText);
      else if (meter.hasAttribute('aria-valuetext')) meter.removeAttribute('aria-valuetext');
      if (fill !== progress.fill) {
        fill = progress.fill;
        meter.style.setProperty('--progress-fill', `${fill * 100}%`);
      }
      updateText(instruction, hintsEnabled ? progress.instruction : '');
      updateText(detail, hintsEnabled ? progress.detail : '');
      size ??= root.getBoundingClientRect();
      const { x, y } = progressPosition(ring, anchor.fighter, size, scoreboardBottom, anchor.count);
      const position = `translate(${x}px, ${y}px)`;
      if (transform !== position) {
        transform = position;
        root.style.transform = position;
      }
    }
  };
}
