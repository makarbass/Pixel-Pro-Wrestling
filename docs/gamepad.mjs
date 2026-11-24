const CHORD_WINDOW = 80;
const JOYSTICK_DEAD_ZONE = 0.18;
const NEUTRAL_STICK = Object.freeze({ x: 0, z: 0, offsetX: 0, offsetY: 0 });
const JUMP_DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const CHORDS = {
  AX: 'signature',
  BX: 'interact',
  BY: 'guard',
  XY: 'taunt',
  AY: 'pause'
};
export const FACE_ACTIONS = { A: 'strike', B: 'throw', X: 'jump', Y: 'context' };

export function contextAction({ pin, hold }, pinAvailable) {
  return pin || (hold?.index === 1 && hold.phase === 'clinch') || pinAvailable ? 'pin' : 'guard';
}

export function createFaceInput(onPress, onRelease, clock = globalThis, now = () => performance.now()) {
  const presses = new Map();

  function activate(action, members) {
    const activation = { action, released: false };
    for (const press of members) {
      clock.clearTimeout(press.timer);
      press.activation = activation;
    }
    onPress(action);
  }

  function start(button) {
    if (presses.has(button)) return;
    const press = { time: now(), timer: null, activation: null };
    for (const [other, pending] of presses) {
      const action = CHORDS[[button, other].sort().join('')];
      if (!action || pending.activation || press.time - pending.time >= CHORD_WINDOW) continue;
      presses.set(button, press);
      activate(action, [pending, press]);
      return;
    }
    presses.set(button, press);
    press.timer = clock.setTimeout(() => activate(FACE_ACTIONS[button], [press]), CHORD_WINDOW);
  }

  function end(button, cancelled = false) {
    const press = presses.get(button);
    if (!press) return;
    clock.clearTimeout(press.timer);
    if (!press.activation && !cancelled) activate(FACE_ACTIONS[button], [press]);
    presses.delete(button);
    const active = press.activation;
    if (active && !active.released) {
      active.released = true;
      onRelease(active.action);
    }
  }

  return { start, end, reset() {
    for (const button of presses.keys()) end(button, true);
  } };
}

export function joystickPosition(dx, dy, radius) {
  const distance = Math.hypot(dx, dy);
  if (!distance || radius <= 0) return NEUTRAL_STICK;
  const travel = Math.min(distance, radius);
  const speed = Math.max(0, (travel / radius - JOYSTICK_DEAD_ZONE) / (1 - JOYSTICK_DEAD_ZONE));
  return {
    x: speed ? dx / distance * speed : 0,
    z: speed ? dy / distance * speed : 0,
    offsetX: dx / distance * travel,
    offsetY: dy / distance * travel
  };
}

export function joystickJumpDirection({ x, z }) {
  if (!x && !z) return { x: 0, z: 0 };
  const sector = Math.round(Math.atan2(z, x) / (Math.PI / 4));
  const [jumpX, jumpZ] = JUMP_DIRECTIONS[(sector + 8) % 8];
  return { x: jumpX, z: jumpZ };
}

export function createGamepad(root, { onUse, onButton, onDirection, onPress, onRelease }) {
  const pad = root.querySelector('.d-pad');
  const joystick = root.querySelector('.joystick');
  const buttons = [...root.querySelectorAll('button')];
  const faceButtons = new Map(buttons.filter((button) => button.dataset.face)
    .map((button) => [button.dataset.face, button]));
  const pointers = new Map();
  const face = createFaceInput(onPress, onRelease);
  let stickPointer = null;
  let movement = NEUTRAL_STICK;
  let fighting = false;

  function updatePressed() {
    const pressedButtons = new Set(pointers.values());
    for (const button of buttons) {
      button.toggleAttribute('data-down', pressedButtons.has(button));
    }
  }

  function setStickPosition(position) {
    movement = position;
    joystick.style.setProperty('--stick-x', `${position.offsetX}px`);
    joystick.style.setProperty('--stick-y', `${position.offsetY}px`);
  }

  function moveStick(event) {
    const { x, y, radius } = stickPointer;
    setStickPosition(joystickPosition(event.clientX - x, event.clientY - y, radius));
  }

  function resetStick() {
    stickPointer = null;
    setStickPosition(NEUTRAL_STICK);
    joystick.removeAttribute('data-down');
  }

  function setLabel(id, label) {
    const button = faceButtons.get(id);
    const caption = button.querySelector('.face-caption');
    if (caption.textContent === label) return;
    caption.textContent = label;
    button.setAttribute('aria-label', label ? `${id} · ${label}` : id);
  }

  function endPointer(event) {
    if (stickPointer?.id === event.pointerId) {
      resetStick();
      return;
    }
    const button = pointers.get(event.pointerId);
    if (!button) return;
    pointers.delete(event.pointerId);
    updatePressed();
    const cancelled = event.type !== 'pointerup';
    if (fighting) {
      if (button.dataset.face) face.end(button.dataset.face, cancelled);
    } else if (!cancelled) {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!button.contains(target)) return;
      if (button.dataset.face) onButton(button.dataset.face);
      else onDirection(button.dataset.direction);
    }
  }

  joystick.addEventListener('pointerdown', (event) => {
    if (!fighting || stickPointer || event.button !== 0 || pointers.has(event.pointerId)) return;
    const { left, top, width, height } = joystick.getBoundingClientRect();
    const radius = Math.min(width, height) / 3 - 4;
    if (radius <= 0) return;
    event.preventDefault();
    onUse();
    root.setPointerCapture(event.pointerId);
    stickPointer = { id: event.pointerId, x: left + width / 2, y: top + height / 2, radius };
    joystick.setAttribute('data-down', '');
    moveStick(event);
  });

  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || event.button !== 0 || pointers.has(event.pointerId)) return;
    if (button.dataset.face && [...pointers.values()].includes(button)) return;
    event.preventDefault();
    onUse();
    root.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, button);
    updatePressed();
    if (fighting && button.dataset.face) face.start(button.dataset.face);
  });

  root.addEventListener('pointermove', (event) => {
    if (stickPointer?.id === event.pointerId) moveStick(event);
  });
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  root.addEventListener('lostpointercapture', endPointer);
  root.addEventListener('contextmenu', (event) => event.preventDefault());

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || event.detail !== 0) return;
    onUse();
    if (fighting && button.dataset.face) {
      const action = FACE_ACTIONS[button.dataset.face];
      onPress(action);
      onRelease(action);
    } else if (button.dataset.face) onButton(button.dataset.face);
    else onDirection(button.dataset.direction);
  });

  return {
    get movement() { return movement; },
    setScreen({ fight = false, move = false, labels = {} } = {}) {
      fighting = fight;
      pad.hidden = fight;
      joystick.hidden = !fight;
      for (const button of buttons) {
        const id = button.dataset.face;
        if (!id) {
          button.disabled = !move;
          continue;
        }
        button.disabled = !labels[id];
        setLabel(id, labels[id] || '');
      }
    },
    setLabel,
    reset() {
      const captured = [...pointers.keys()];
      if (stickPointer) {
        captured.push(stickPointer.id);
        resetStick();
      }
      pointers.clear();
      face.reset();
      updatePressed();
      for (const id of captured) {
        if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
      }
    }
  };
}
