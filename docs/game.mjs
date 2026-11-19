import {
  availableInteraction, canPin, canReachRopes, createMatch, STEP, stepMatch
} from './match.mjs';
import { createRenderer, loadArt } from './render.mjs';
import { drawPixelText } from './pixel-text.mjs';
import { createMatchMenu } from './menu.mjs';
import { createGameAudio } from './audio.mjs';
import { GRAPPLES, ROSTER, SIGNATURES } from './roster.mjs';

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
const overlay = get('overlay');
const overlayHeading = get('overlay-heading');
const overlayText = get('overlay-text');
const overlayActions = get('overlay-actions');
const overlayPrimary = get('overlay-primary');
const overlayMenu = get('overlay-menu');
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
const interactionHints = {
  climb: 'E — Climb the turnbuckle',
  descend: 'I — Dive · E — Climb down',
  exit: 'E — Leave the ring',
  enter: 'E — Enter the ring'
};
const resultText = {
  pin: 'Three-count pinfall.',
  time: 'Time expired.',
  countout: 'Your opponent was counted out.',
  'double-countout': 'Both wrestlers were counted out.'
};
const held = new Set();
const buffered = new Map();
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

function describe(text) {
  if (announcement.textContent !== text) announcement.textContent = text;
}

function showOverlay(heading, body = '', primary = '', menu = true) {
  overlayHeading.textContent = heading;
  overlayText.textContent = body;
  overlayText.hidden = !body;
  overlayPrimary.textContent = primary;
  overlayActions.hidden = !primary;
  overlayMenu.hidden = !menu;
  overlay.hidden = false;
}

function setMode(next) {
  mode = next;
  const onRing = mode === 'fight' || mode === 'paused' || mode === 'result';
  audio.setTrack(mode === 'fight' || mode === 'menu' ? 'crowd' : null);
  stage.classList.toggle('setup-stage', !onRing);
  canvas.hidden = !onRing;
  scoreboard.hidden = !onRing;
  stageFooter.hidden = !onRing;
  menuRoot.hidden = mode !== 'menu';
  pause.hidden = mode !== 'fight';
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
  if (signatureCooldown.textContent !== cooldownText) signatureCooldown.textContent = cooldownText;

  match.fighters.forEach((fighter, index) => {
    const meter = health[index];
    const value = String(fighter.health);
    if (meter.getAttribute('aria-valuenow') === value) return;
    meter.setAttribute('aria-valuenow', value);
    meter.style.setProperty('--health', `${value}%`);
  });
}

function updateCall() {
  const { pin, hold, outside } = match;
  call.hidden = mode !== 'fight' || outside.elapsed === 0;
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
    const player = match.fighters[0];
    if (pin) {
      hint = pin.attacker === 0 ? 'Tap Space to keep the pin' : 'Tap Space to kick out';
      if (pin.attacker === 1 && canReachRopes(player)) hint += ' · L — Grab the rope';
    } else if (hold) {
      if (hold.phase === 'clinch') {
        if (hold.index === 1) hint = `Space — Escape ${hold.escape}/${hold.needed}`;
        else if (!hold.contact.signature && !hold.queued) hint = 'K — Throw';
      }
    } else if (canPin(match, 0)) {
      hint = 'Press Space to pin';
    } else if (match.fighters[1].attack?.name === 'shove' && player.pose === 'perch') {
      hint = 'Shove incoming · I — Dive';
    } else if (player.motion?.kind === 'jump' && !player.motion.strike) {
      hint = 'J — Air strike';
    } else if (!pin) {
      hint = interactionHints[availableInteraction(player)?.name] || '';
      if (!hint && player.rush && !player.rush.queued) hint = 'J — Running strike';
      if (!hint && player.combo) hint = player.combo.hits === 2 ? 'K — Finish combo' : 'J or K — Continue combo';
    }
  }
  if (pinHint.textContent !== hint) pinHint.textContent = hint;
  pinHint.hidden = !hint;
}

function render() {
  let message = '';
  if (mode === 'fight') {
    if (match.pin && match.pin.count === 0) message = 'PIN';
    else if (match.elapsed < 0.65 && !match.outside.elapsed && !match.pin) message = 'FIGHT!';
  }
  draw(selection.arena, match, !reducedMotion.matches, {
    reducedMotion: reducedMotion.matches,
    presentation: resultDisplayTime,
    call: message
  });
  updateScore();
  updateCall();
}

function clearInput() {
  held.clear();
  buffered.clear();
}

function stopClock() {
  cancelAnimationFrame(frameId);
  clearInput();
  lastTime = null;
  accumulated = 0;
}

function input() {
  const directions = new Set([...held].map((key) => movement[key]));
  const command = {
    x: Number(directions.has('right')) - Number(directions.has('left')),
    z: Number(directions.has('front')) - Number(directions.has('back')),
    block: held.has('KeyL'),
    ropeBreak: buffered.has('ropeBreak'),
    strike: buffered.has('strike'),
    signature: buffered.has('signature'),
    throw: buffered.get('throw') || 0,
    jump: buffered.has('jump'),
    interact: buffered.has('interact'),
    taunt: buffered.has('taunt'),
    pin: buffered.get('pin') || 0
  };
  buffered.clear();
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
    stepMatch(match, input());
    if (match.end) audio.setTrack(null);
    if (match.pin !== previousPin) {
      if (!match.pin) describe(match.pinBreak === 'rope' ? 'Rope break. The referee stopped the pin.' : 'The pin was broken.');
      else if (match.pin.attacker === 0) describe('Pin. Tap Space to keep the pin.');
      else {
        const player = match.fighters[0];
        const rope = canReachRopes(player) ? ' Press L to grab the rope.' : '';
        describe(`Your opponent is pinning you. Tap Space to kick out.${rope}`);
      }
    } else if (match.pin && match.pin.count > previousPinCount) {
      describe(`Pin count ${match.pin.count}.`);
    } else if (match.fighters[0].motion?.kind === 'fall' && match.fighters[0].motion !== previousMotion) {
      describe('Your opponent shoved you off the turnbuckle.');
    } else if (!previousOutside && match.outside.elapsed) {
      describe('The referee started the countout.');
    } else if (previousOutside && !match.outside.elapsed) {
      describe('Both wrestlers returned to the ring.');
    } else if (match.outside.count > previousCount) {
      describe(`Countout ${match.outside.count}.`);
    } else if (match.hold !== previousHold && match.hold) {
      if (match.hold.index === 1) describe(`Grapple. Tap Space ${match.hold.needed} times to escape.`);
      else describe(match.hold.contact.signature ? 'Signature grapple.' : 'Grapple. Press K to throw.');
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
  render();
  const resultDelay = match.end?.reason === 'pin' ? 0.65 : 0.4;
  if (match.end && (match.end.reason === 'time' || resultDisplayTime >= resultDelay)) {
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
  const text = reason === 'countout' && winner === 1
    ? 'You were counted out.'
    : resultText[reason];
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
  describe('');
  menu.openHome();
}

function setMatchPresentation() {
  const { player, opponent, arena } = selection;
  const view = art.arenas[arena];
  signatureName.textContent = SIGNATURES[player].label;
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
overlayMenu.addEventListener('click', showMenu);
overlayPrimary.addEventListener('click', () => {
  if (mode === 'paused') resumeFight();
  else if (mode === 'result') startFight();
  else if (mode === 'error') boot();
});

window.addEventListener('click', (event) => {
  if (event.isTrusted && !soundToggle.contains(event.target)) audio.activate();
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
  held.add(code);
  const action = code === 'KeyJ' && event.shiftKey ? 'signature' : actions[code];
  if (action) buffered.set(action, (buffered.get(action) || 0) + 1);
});

window.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', pauseFight);
canvas.addEventListener('blur', clearInput);
canvas.addEventListener('click', () => {
  if (mode === 'fight') focusRing();
});
document.addEventListener('visibilitychange', () => {
  if (mode === 'menu') menu.updatePresentation();
  else if (document.hidden) pauseFight();
  audio.visibilityChanged();
});
reducedMotion.addEventListener('change', () => {
  if (mode === 'menu') menu.updatePresentation();
  else if (mode === 'fight' || mode === 'paused' || mode === 'result') render();
});

boot();
