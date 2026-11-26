import {
  availableInteraction, canPin, canPinReferee, canReachRopes, createMatch, STEP, stepMatch
} from './match.mjs';
import { createRenderer, loadArt } from './render.mjs';
import { drawPixelText } from './pixel-text.mjs';
import { createMatchMenu } from './menu.mjs';
import { createGameAudio } from './audio.mjs';
import { contextAction, createGamepad, joystickJumpDirection } from './gamepad.mjs';
import { GRAPPLES, ROSTER, SIGNATURES } from './roster.mjs';
import { advanceReferee, canRefereeCount, refereeHasLeft, REFEREE_ATTACK_LIMIT } from './referee.mjs';

const get = (id) => document.getElementById(id);
const canvas = get('ring');
const stage = canvas.parentElement;
const menuRoot = get('match-menu');
const soundToggle = get('sound-toggle');
const soundState = get('sound-state');
const scoreboard = get('scoreboard');
const stageFooter = get('stage-footer');
const pause = get('pause');
const timer = get('timer');
const timerValue = get('timer-value');
const timerFace = get('timer-face');
const signatureName = get('signature-name');
const grappleName = get('grapple-name');
const signatureCooldown = get('signature-cooldown');
const gamepadSignature = get('gamepad-signature');
const gamepadCooldown = get('gamepad-cooldown');
const overlay = get('overlay');
const overlayHeading = get('overlay-heading');
const overlayText = get('overlay-text');
const overlayActions = get('overlay-actions');
const overlayPrimary = get('overlay-primary');
const overlayMenu = get('overlay-menu');
const gamepadRoot = get('gamepad');
const gamepadGuide = get('gamepad-guide');
const call = get('match-call');
const pinHint = get('pin-hint');
const pinPressure = get('pin-pressure');
const announcement = get('announcement');
const health = [get('player-meter'), get('bot-meter')];
const avatars = [get('player-avatar'), get('bot-avatar')];

const movement = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'back', KeyW: 'back',
  ArrowDown: 'front', KeyS: 'front'
};
const actions = {
  KeyJ: 'strike', KeyK: 'throw', KeyI: 'jump', KeyE: 'interact', KeyL: 'ropeBreak',
  KeyT: 'taunt', Space: 'pin'
};
const directionKeys = { left: 'ArrowLeft', right: 'ArrowRight', back: 'ArrowUp', front: 'ArrowDown' };
const interactionNames = { climb: 'Climb the turnbuckle', exit: 'Leave the ring', enter: 'Enter the ring' };
const controlLabels = {
  keyboard: { strike: 'J', throw: 'K', jump: 'I', interact: 'E', ropeBreak: 'L', pin: 'Space' },
  gamepad: { strike: 'A', throw: 'B', jump: 'X', interact: 'B + X', ropeBreak: 'B + Y', pin: 'Y' }
};
const resultText = {
  pin: 'Three-count pinfall.',
  knockout: 'Won by knockout.',
  time: 'Time expired.',
  stamina: 'Won by remaining stamina at the time limit.',
  countout: 'Your opponent was counted out.',
  'double-countout': 'Both wrestlers were counted out.'
};
const held = new Set();
const buffered = new Map();
const gamepadBuffer = new Map();
const gamepadLayout = window.matchMedia('(max-width: 760px), (any-pointer: coarse)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const audio = createGameAudio();
let selection;
let match;
let art;
let draw;
let menu;
let mode = 'loading';
let frameId = 0;
let lastTime = null;
let accumulated = 0;
let resultDisplayTime = 0;
let paintedClock;
let controlScheme = gamepadLayout.matches ? 'gamepad' : 'keyboard';
let gamepadGuard = false;
let overlayChoice;

const gamepad = createGamepad(gamepadRoot, {
  onUse() { controlScheme = 'gamepad'; },
  onButton: handleGamepadButton,
  onDirection: handleGamepadDirection,
  onPress: pressGamepadAction,
  onRelease(action) {
    if (action === 'context' || action === 'guard') gamepadGuard = false;
  }
});

function bufferAction(buffer, action) {
  buffer.set(action, (buffer.get(action) || 0) + 1);
}

function pressGamepadAction(action) {
  if (mode !== 'fight' || match.end) return;
  if (action === 'pause') {
    pauseFight();
    return;
  }
  const contextual = action === 'context';
  if (contextual) action = contextAction(match, canPin(match, 0) || canPinReferee(match, 0));
  if (action === 'guard') {
    gamepadGuard = true;
    bufferAction(gamepadBuffer, 'block');
    if (!contextual) bufferAction(gamepadBuffer, 'ropeBreak');
  } else {
    bufferAction(gamepadBuffer, action);
  }
}

function updateGamepad(screen) {
  gamepadGuide.hidden = mode !== 'fight';
  switch (mode) {
    case 'fight':
      gamepad.setScreen({ fight: true, labels: { A: 'Strike', B: 'Grapple', X: 'Jump', Y: 'Block' } });
      break;
    case 'menu':
      gamepad.setScreen(screen === 'versus'
        ? { labels: { B: 'Back' } }
        : { move: true, labels: { A: 'Select', B: screen === 'home' ? '' : 'Back' } });
      break;
    case 'paused':
      gamepad.setScreen({ move: true, labels: { A: 'Select', B: 'Resume' } });
      break;
    case 'result':
      gamepad.setScreen({ move: true, labels: { A: 'Select', B: 'Menu' } });
      break;
    case 'error':
      gamepad.setScreen({ labels: { A: 'Retry' } });
      break;
    default:
      gamepad.setScreen();
  }
}

function handleGamepadButton(button) {
  if (mode === 'menu') {
    if (button === 'A') menu.confirm();
    else if (button === 'B') menu.back();
  } else if (button === 'A' && (mode === 'paused' || mode === 'result' || mode === 'error')) {
    overlayChoice.click();
  } else if (button === 'B') {
    if (mode === 'paused') resumeFight();
    else if (mode === 'result') showMenu();
  }
}

function handleGamepadDirection(direction) {
  if (mode === 'menu') menu.move(directionKeys[direction]);
  else if (mode === 'paused' || mode === 'result') {
    const button = direction === 'left' || direction === 'back' ? overlayPrimary : overlayMenu;
    setOverlayChoice(button);
    button.focus({ preventScroll: true });
  }
}

function describe(text) {
  if (announcement.textContent !== text) announcement.textContent = text;
}

function setOverlayChoice(button) {
  if (overlayChoice === button) return;
  overlayChoice?.removeAttribute('data-current');
  overlayChoice = button;
  button.setAttribute('data-current', '');
}

function showOverlay(heading, body = '', primary = '', menu = true) {
  overlayHeading.textContent = heading;
  overlayText.textContent = body;
  overlayText.hidden = !body;
  overlayPrimary.textContent = primary;
  overlayActions.hidden = !primary;
  overlayMenu.hidden = !menu;
  overlay.hidden = false;
  setOverlayChoice(overlayPrimary);
}

function setMode(next) {
  clearGamepadInput();
  mode = next;
  const onRing = mode === 'fight' || mode === 'paused' || mode === 'result';
  audio.setTrack(mode === 'fight' || mode === 'menu' ? 'crowd' : null);
  stage.classList.toggle('setup-stage', !onRing);
  canvas.hidden = !onRing;
  scoreboard.hidden = !onRing;
  stageFooter.hidden = !onRing;
  menuRoot.hidden = mode !== 'menu';
  pause.hidden = mode !== 'fight';
  canvas.setAttribute('aria-describedby', gamepadLayout.matches ? 'gamepad-guide' : 'controls-keys');
  if (mode !== 'menu') updateGamepad();
}

function updateScore() {
  const seconds = Math.ceil(match.clock);
  const minutes = Math.floor(seconds / 60);
  const clockText = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if (paintedClock !== clockText) {
    paintedClock = clockText;
    timerValue.textContent = clockText;
    timer.dateTime = `PT${seconds}S`;
    const ctx = timerFace.getContext('2d');
    const ink = window.getComputedStyle(timerFace).getPropertyValue('--gold').trim() || '#ffcd56';
    ctx.clearRect(0, 0, timerFace.width, timerFace.height);
    drawPixelText(ctx, clockText, timerFace.width / 2, timerFace.height - 2, 3, ink);
  }
  const secondsToReady = Math.ceil(Math.max(0, match.fighters[0].signatureCooldown - 1e-8));
  const cooldownText = secondsToReady > 0 ? `${secondsToReady}s` : '';
  if (signatureCooldown.textContent !== cooldownText) {
    signatureCooldown.textContent = cooldownText;
    gamepadCooldown.textContent = cooldownText;
  }

  match.fighters.forEach((fighter, index) => {
    const meter = health[index];
    const value = String(fighter.health);
    if (meter.getAttribute('aria-valuenow') === value) return;
    meter.setAttribute('aria-valuenow', value);
    meter.style.setProperty('--health', `${value}%`);
  });
}

function refereeCall() {
  const { referee, elapsed } = match;
  const sinceChange = elapsed - referee.changedAt;
  if (referee.phase === 'fleeing') return 'Referee fleeing';
  if (referee.phase === 'gone' && sinceChange < 3.3) return 'Referee left';
  if (referee.phase === 'down' && sinceChange < 1.4 && !referee.interaction) {
    return `Referee down · ${referee.attacks}/${REFEREE_ATTACK_LIMIT}`;
  }
  return '';
}

function updateCall(refereeMessage) {
  const { pin, hold, outside, referee } = match;
  const keys = controlLabels[controlScheme];
  const counting = canRefereeCount(referee);
  const callText = refereeMessage || (outside.elapsed > 0 && counting ? 'Outside' : '');
  if (call.textContent !== callText) call.textContent = callText;
  call.hidden = mode !== 'fight' || !callText;
  pinPressure.hidden = mode !== 'fight' || !pin || Boolean(match.end);
  if (!pinPressure.hidden) {
    const pressure = String(Math.ceil(pin.pressure * 100));
    if (pressure !== pinPressure.getAttribute('aria-valuenow')) {
      pinPressure.style.setProperty('--pressure', pressure + '%');
      pinPressure.setAttribute('aria-valuenow', pressure);
    }
  }

  let hint = '';
  if (mode === 'fight' && !match.end) {
    const [player, opponent] = match.fighters;
    const { knockdown } = player;
    const pinAvailable = canPin(match, 0);
    const refereePinAvailable = canPinReferee(match, 0);
    const refereeAction = referee.interaction;
    const refereePinning = refereeAction?.index === 0 && refereeAction.phase === 'pin';
    const context = contextAction(match, pinAvailable || refereePinAvailable);
    if (gamepadLayout.matches) {
      const escaping = pin?.attacker === 1 || hold?.index === 1;
      let yLabel = player.health > 0 ? 'Block' : '';
      if (context === 'pin') yLabel = escaping ? 'Escape' : knockdown ? 'Get up' : 'Pin';
      gamepad.setLabel('Y', yLabel);
      const clinch = hold || refereeAction;
      gamepad.setLabel('B', clinch?.index === 0 && clinch.phase === 'clinch' ? 'Throw' : 'Grapple');
    }
    const interaction = availableInteraction(player)?.name;
    if (pin) {
      hint = pin.attacker === 0 ? `Tap ${keys.pin} to keep the pin` : `Tap ${keys.pin} to kick out`;
      if (pin.attacker === 1 && canReachRopes(player)) hint += ` · ${keys.ropeBreak} — Grab the rope`;
      if (!counting) hint += ' · No count';
    } else if (knockdown) {
      const seconds = Math.max(0, Math.ceil(knockdown.deadline - match.elapsed - 1e-8));
      hint = `Tap ${keys.pin} to get up · ${knockdown.taps}/${knockdown.needed} · ${seconds}s`;
    } else if (hold) {
      if (hold.phase === 'clinch') {
        if (hold.index === 1) hint = `${keys.pin} — Escape ${hold.escape}/${hold.needed}`;
        else if (!hold.contact.signature && !hold.queued) hint = `${keys.throw} — Throw`;
      }
    } else if (refereeAction) {
      if (refereeAction.index === 1) hint = `${keys.strike} — Interrupt`;
      else if (refereePinning) hint = 'Pinning the referee · No count';
      else if (refereeAction.phase === 'clinch' && !refereeAction.signature && !refereeAction.queued) {
        hint = `${keys.throw} — Throw the referee`;
      }
    } else if (pinAvailable) {
      hint = `Press ${keys.pin} to pin`;
      if (opponent.knockdown) hint += ` · ${Math.ceil(opponent.knockdown.deadline - match.elapsed - 1e-8)}s to get up`;
    } else if (refereePinAvailable) {
      hint = `${keys.pin} — Pin the referee`;
    } else if (match.fighters[1].attack?.name === 'shove' && player.pose === 'perch') {
      hint = `Shove incoming · ${keys.jump} — Dive`;
    } else if (player.motion?.kind === 'jump' && !player.motion.strike) {
      hint = `${keys.strike} — Air strike`;
    } else if (interaction === 'descend') {
      hint = `${keys.jump} — Dive · ${keys.interact} — Climb down`;
    } else if (interaction) {
      hint = `${keys.interact} — ${interactionNames[interaction]}`;
    } else if (player.rush && !player.rush.queued) {
      hint = `${keys.strike} — Running strike`;
    } else if (player.combo) {
      hint = player.combo.hits === 2 ? `${keys.throw} — Finish combo` : `${keys.strike} or ${keys.throw} — Continue combo`;
    }
    if (!hint && refereeHasLeft(referee)) hint = 'Stamina decides at the time limit';
  }
  if (pinHint.textContent !== hint) pinHint.textContent = hint;
  pinHint.hidden = !hint;
}

function render() {
  let message = '';
  const refereeMessage = refereeCall();
  if (mode === 'fight' && !refereeMessage) {
    if (match.pin && match.pin.count === 0 && (canRefereeCount(match.referee) || match.pin.elapsed < 0.65)) message = 'PIN';
    else if (match.elapsed < 0.65 && !match.outside.elapsed && !match.pin) message = 'FIGHT!';
  }
  draw(selection.arena, match, !reducedMotion.matches, {
    reducedMotion: reducedMotion.matches,
    presentation: resultDisplayTime,
    call: message
  });
  updateScore();
  updateCall(refereeMessage);
}

function clearKeyboardInput() {
  held.clear();
  buffered.clear();
}

function clearGamepadInput() {
  gamepad.reset();
  gamepadBuffer.clear();
  gamepadGuard = false;
}

function stopClock() {
  cancelAnimationFrame(frameId);
  clearKeyboardInput();
  lastTime = null;
  accumulated = 0;
}

function input() {
  const directions = new Set();
  for (const key of held) {
    if (movement[key]) directions.add(movement[key]);
  }
  const count = (action) => (buffered.get(action) || 0) + (gamepadBuffer.get(action) || 0);
  const jump = Boolean(count('jump'));
  let direction = gamepad.movement;
  if (directions.size) {
    direction = {
      x: Number(directions.has('right')) - Number(directions.has('left')),
      z: Number(directions.has('front')) - Number(directions.has('back'))
    };
  } else if (jump) {
    direction = joystickJumpDirection(direction);
  }
  const command = {
    x: direction.x,
    z: direction.z,
    block: held.has('KeyL') || (!match.pin && (gamepadGuard || gamepadBuffer.has('block'))),
    ropeBreak: Boolean(count('ropeBreak')),
    strike: Boolean(count('strike')),
    signature: Boolean(count('signature')),
    throw: count('throw'),
    jump,
    interact: Boolean(count('interact')),
    taunt: Boolean(count('taunt')),
    pin: count('pin')
  };
  buffered.clear();
  gamepadBuffer.clear();
  return command;
}

function tick(now) {
  if (mode !== 'fight') return;
  const delta = lastTime === null ? 0 : Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  if (match.end) resultDisplayTime += delta;
  accumulated += delta;
  while (accumulated + 1e-10 >= STEP && !match.end) {
    const previousPin = match.pin;
    const previousPinCount = previousPin?.count;
    const previousHold = match.hold;
    const previousHoldPhase = previousHold?.phase;
    const previousMotion = match.fighters[0].motion;
    const previousOutside = match.outside.elapsed;
    const previousCount = match.outside.count;
    const previousPoses = match.fighters.map((fighter) => fighter.pose);
    const previousKnockdown = match.fighters[0].knockdown;
    const previousRefereePhase = match.referee.phase;
    const previousRefereeAttacks = match.referee.attacks;
    stepMatch(match, input());
    if (match.end) {
      clearGamepadInput();
      audio.setTrack(null);
    }
    const keys = controlLabels[controlScheme];
    if (match.referee.attacks !== previousRefereeAttacks) {
      describe(refereeHasLeft(match.referee) ? 'The referee is leaving. Stamina decides at the time limit.' :
        `Referee down. ${match.referee.attacks} of ${REFEREE_ATTACK_LIMIT} attacks.`);
    } else if (previousRefereePhase === 'down' && match.referee.phase === 'standing') {
      describe('The referee is back on his feet.');
    } else if (match.pin !== previousPin) {
      if (!match.pin) describe(match.pinBreak === 'rope' ? 'Rope break. The pin ended.' : 'The pin was broken.');
      else if (match.pin.attacker === 0) describe(`Pin. Tap ${keys.pin} to keep the pin.`);
      else {
        const player = match.fighters[0];
        const rope = canReachRopes(player) ? ` Press ${keys.ropeBreak} to grab the rope.` : '';
        describe(`Your opponent is pinning you. Tap ${keys.pin} to kick out.${rope}`);
      }
    } else if (match.pin && match.pin.count > previousPinCount) {
      describe(`Pin count ${match.pin.count}.`);
    } else if (match.fighters[0].knockdown && match.fighters[0].knockdown !== previousKnockdown) {
      describe(`Knockdown. Tap ${keys.pin} ${match.fighters[0].knockdown.needed} times to get up. You have four seconds.`);
    } else if (previousKnockdown && match.fighters[0].pose === 'rise') {
      describe('Getting up.');
    } else if (match.fighters[0].motion?.kind === 'fall' && match.fighters[0].motion !== previousMotion) {
      describe('Your opponent shoved you off the turnbuckle.');
    } else if (!previousOutside && match.outside.elapsed && canRefereeCount(match.referee)) {
      describe('The referee started the countout.');
    } else if (previousOutside && !match.outside.elapsed) {
      describe('Both wrestlers returned to the ring.');
    } else if (match.outside.count > previousCount) {
      describe(`Countout ${match.outside.count}.`);
    } else if (match.hold !== previousHold && match.hold) {
      if (match.hold.index === 1) describe(`Grapple. Tap ${keys.pin} ${match.hold.needed} times to escape.`);
      else describe(match.hold.contact.signature ? 'Signature grapple.' : `Grapple. Press ${keys.throw} to throw.`);
    } else if (match.hold?.phase === 'throw' && previousHoldPhase === 'clinch') {
      describe('Throw.');
    } else if (previousHoldPhase === 'clinch' && !match.hold) {
      describe('Grapple released.');
    } else {
      const taunt = match.fighters.find((fighter, index) => fighter.pose === 'taunt' && previousPoses[index] !== 'taunt');
      if (taunt) describe(`${ROSTER[taunt.id]} taunts.`);
    }
    accumulated -= STEP;
  }
  if (match.end && match.referee.phase === 'fleeing') {
    advanceReferee(match.referee, match.elapsed + resultDisplayTime);
  }
  render();
  const resultDelay = match.end?.reason === 'pin' ? 0.65 : 0.4;
  const timedResult = match.end?.reason === 'time' || match.end?.reason === 'stamina';
  if (match.end && match.referee.phase !== 'fleeing' && (timedResult || resultDisplayTime >= resultDelay)) {
    finish();
  } else {
    frameId = requestAnimationFrame(tick);
  }
}

function focusRing() {
  canvas.focus({ preventScroll: true });
}

function startFight(chosen = selection) {
  stopClock();
  selection = chosen;
  setMatchPresentation();
  match = createMatch(selection.player, selection.opponent);
  resultDisplayTime = 0;
  setMode('fight');
  describe('Match started.');
  overlay.hidden = true;
  render();
  focusRing();
  frameId = requestAnimationFrame(tick);
}

function pauseFight() {
  if (mode !== 'fight' || match.end) return;
  stopClock();
  setMode('paused');
  showOverlay('Paused', '', 'Resume Match');
  render();
  overlayPrimary.focus({ preventScroll: true });
}

function resumeFight() {
  setMode('fight');
  overlay.hidden = true;
  render();
  focusRing();
  frameId = requestAnimationFrame(tick);
}

function finish() {
  stopClock();
  setMode('result');
  const { winner, reason } = match.end;
  const title = winner === 0 ? 'You win' : winner === 1 ? `${ROSTER[match.fighters[1].id]} wins` : 'Draw';
  let text = resultText[reason];
  if (reason === 'countout' && winner === 1) text = 'You were counted out.';
  if (reason === 'stamina' && winner === null) text = 'Time expired with equal stamina.';
  if (reason === 'knockout' && winner === null) text = 'Double knockout.';
  showOverlay(title, text, 'Rematch');
  describe(`${title}. ${text}`);
  render();
  overlayPrimary.focus({ preventScroll: true });
}

function showMenu() {
  stopClock();
  setMode('menu');
  overlay.hidden = true;
  call.hidden = true;
  grappleName.textContent = 'Throw';
  signatureName.textContent = 'Signature move';
  signatureCooldown.textContent = '';
  gamepadCooldown.textContent = '';
  describe('');
  menu.openHome();
}

function setMatchPresentation() {
  const { player, opponent, arena } = selection;
  const view = art.arenas[arena];
  signatureName.textContent = SIGNATURES[player].label;
  gamepadSignature.textContent = SIGNATURES[player].label;
  grappleName.textContent = GRAPPLES[player].label;
  get('venue-name').textContent = view.name;
  stage.style.setProperty('--arena-ratio', view.size.join(' / '));

  [player, opponent].forEach((id, index) => {
    avatars[index].src = art.avatars[id];
    health[index].setAttribute('aria-label', `${ROSTER[id]} stamina`);
  });
}

async function boot() {
  setMode('loading');
  showOverlay('Loading arena');
  audio.prepare();
  try {
    art = await loadArt();
    draw = createRenderer(canvas, art);
    menu = createMatchMenu(menuRoot, art.arenas, startFight, reducedMotion, (screen, versusOffset) => {
      clearGamepadInput();
      updateGamepad(screen);
      if (screen === 'versus') audio.setTrack('versus', versusOffset);
      else audio.setTrack('crowd');
    });
    showMenu();
  } catch (error) {
    console.error(error);
    setMode('error');
    showOverlay('Could not load the arena', 'Try loading it again.', 'Retry', false);
    overlayPrimary.focus({ preventScroll: true });
  }
}

function showSoundSetting() {
  soundToggle.setAttribute('aria-pressed', String(audio.enabled));
  soundState.textContent = audio.enabled ? 'On' : 'Off';
}

showSoundSetting();
soundToggle.addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  showSoundSetting();
  if (audio.enabled) audio.activate();
});

pause.addEventListener('click', pauseFight);
overlayActions.addEventListener('focusin', (event) => {
  if (event.target === overlayPrimary || event.target === overlayMenu) setOverlayChoice(event.target);
});
overlayMenu.addEventListener('click', showMenu);
overlayPrimary.addEventListener('click', () => {
  if (mode === 'paused') resumeFight();
  else if (mode === 'result') startFight();
  else if (mode === 'error') boot();
});

window.addEventListener('click', (event) => {
  if (event.isTrusted && !soundToggle.contains(event.target)) audio.activate();
}, { capture: true });
gamepadRoot.addEventListener('pointerup', (event) => {
  if (event.isTrusted) audio.activate();
}, { capture: true });

window.addEventListener('keydown', (event) => {
  const key = event.key || event.code;
  const confirms = key === 'Enter' || key === ' ' || key === 'Space';
  const soundConfirmation = confirms && document.activeElement === soundToggle;
  const gameKey = confirms || key === 'Tab' || key === 'Escape' || key.startsWith('Arrow') ||
    movement[event.code] || actions[event.code];
  if (event.isTrusted && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey &&
      gameKey && !soundConfirmation) audio.activate();
  if (mode === 'menu') {
    menu.handleKeydown(event);
    return;
  }
  if (key === 'Escape' && (mode === 'fight' || mode === 'paused')) {
    event.preventDefault();
    if (event.repeat) return;
    if (mode === 'fight') pauseFight();
    else resumeFight();
    return;
  }

  if ((mode === 'paused' || mode === 'result') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (key === 'ArrowLeft' || key === 'ArrowUp') {
      event.preventDefault();
      overlayPrimary.focus();
    } else if (key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault();
      overlayMenu.focus();
    }
    return;
  }

  const code = event.code;
  if (mode !== 'fight' || document.activeElement !== canvas || event.ctrlKey ||
      event.metaKey || event.altKey || (!movement[code] && !actions[code])) return;
  event.preventDefault();
  if (event.repeat || held.has(code)) return;
  controlScheme = 'keyboard';
  held.add(code);
  const action = code === 'KeyJ' && event.shiftKey ? 'signature' : actions[code];
  if (action) bufferAction(buffered, action);
});

window.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', () => {
  clearGamepadInput();
  pauseFight();
});
window.addEventListener('resize', clearGamepadInput);
gamepadLayout.addEventListener('change', () => {
  controlScheme = gamepadLayout.matches ? 'gamepad' : 'keyboard';
  clearGamepadInput();
  canvas.setAttribute('aria-describedby', gamepadLayout.matches ? 'gamepad-guide' : 'controls-keys');
});
canvas.addEventListener('blur', clearKeyboardInput);
canvas.addEventListener('click', () => {
  if (mode === 'fight') focusRing();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearGamepadInput();
  if (mode === 'menu') menu.updatePresentation();
  else if (document.hidden) pauseFight();
  audio.visibilityChanged();
});
reducedMotion.addEventListener('change', () => {
  if (mode === 'menu') menu.updatePresentation();
  else if (mode === 'fight' || mode === 'paused' || mode === 'result') render();
});

boot();
