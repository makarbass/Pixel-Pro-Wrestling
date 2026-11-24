import { PRESETS, ROSTER } from './roster.mjs';
import { drawArenaBackdrop } from './render.mjs';
import { clamp } from './arena.mjs';

const VERSUS_ENTRANCE = 3000;
const VERSUS_DURATION = VERSUS_ENTRANCE * 2 + 1000;
const MENU_CHOICE = '[data-menu-columns] > button';
const arrowDirections = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  ArrowUp: [0, -1], ArrowDown: [0, 1]
};

function wrestlerSprite(id, view) {
  const picture = document.createElement('picture');
  picture.className = 'wrestler-sprite';
  const hasWideEffects = id === 'honky' || id === 'yokozuna';
  const rosterVariant = hasWideEffects && view === 'roster';
  const wide = hasWideEffects && view === 'versus';
  picture.classList.toggle('wrestler-sprite-wide', wide);
  const animation = document.createElement('source');
  animation.media = '(prefers-reduced-motion: no-preference)';
  animation.srcset = `assets/${id}-${rosterVariant ? 'roster' : 'lineup'}.png`;
  const still = document.createElement('img');
  still.src = `assets/${id}-${rosterVariant ? 'roster-profile' : 'profile'}.png`;
  still.alt = '';
  still.width = wide ? 104 : 64;
  still.height = 64;
  picture.append(animation, still);
  return picture;
}

function tile(action, id, title, source, detail) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = action === 'fighter' ? 'roster-tile' : 'match-tile';
  button.dataset.action = action;
  button.dataset.id = id;

  const name = document.createElement('strong');
  name.textContent = title;
  if (action === 'fighter') {
    const art = document.createElement('span');
    art.className = 'roster-card-art';
    art.append(wrestlerSprite(id, 'roster'));
    button.append(art, name);
    return button;
  }

  const image = document.createElement('img');
  image.src = source;
  image.alt = '';
  button.append(image, name);
  if (detail) {
    const pairing = document.createElement('span');
    pairing.textContent = detail;
    button.append(pairing);
  }
  return button;
}

export function createMatchMenu(root, arenas, onStart, reducedMotion, onScreenChange) {
  const screens = Object.fromEntries([...root.querySelectorAll('[data-screen]')]
    .map((section) => [section.dataset.screen, section]));
  const get = (id) => root.querySelector(`#${id}`);
  const presetTiles = get('preset-tiles');
  const rosterTiles = get('roster-tiles');
  const arenaTiles = get('arena-tiles');
  const count = get('versus-count');
  const backgroundArena = arenas.night;
  const backdrop = get('menu-backdrop');
  const backdropContext = backdrop.getContext('2d');
  [backdrop.width, backdrop.height] = backgroundArena.size;

  for (const [id, { arena, player, opponent }] of Object.entries(PRESETS)) {
    const pairing = `${ROSTER[player]} — ${ROSTER[opponent]}`;
    presetTiles.append(tile('preset', id, arenas[arena].name, `assets/${arena}-preview.png`, pairing));
  }
  for (const [id, name] of Object.entries(ROSTER)) {
    rosterTiles.append(tile('fighter', id, name));
  }
  for (const [id, { name }] of Object.entries(arenas)) {
    arenaTiles.append(tile('arena', id, name, `assets/${id}-preview.png`));
  }

  let current;
  let highlighted;
  let role;
  let draft;
  let presetId;
  let matchup;
  let elapsed = 0;
  let visibleSince = null;
  let countdownFrame = null;
  let crowdFrame = 0;
  let crowdTimer = null;

  function updateBackdrop() {
    const visible = Boolean(current) && current !== 'versus';
    backdrop.hidden = !visible;
    const animate = visible && !document.hidden && !reducedMotion.matches;
    if (visible) drawArenaBackdrop(backdropContext, backgroundArena, reducedMotion.matches ? 0 : crowdFrame);
    if (animate && crowdTimer === null) {
      const { frames, duration } = backgroundArena.crowd;
      crowdTimer = window.setInterval(() => {
        crowdFrame = (crowdFrame + 1) % frames;
        drawArenaBackdrop(backdropContext, backgroundArena, crowdFrame);
      }, duration * 1000);
    } else if (!animate && crowdTimer !== null) {
      window.clearInterval(crowdTimer);
      crowdTimer = null;
    }
  }

  function highlight(button) {
    if (button === highlighted) return;
    highlighted?.removeAttribute('data-current');
    highlighted = button;
    if (highlighted) highlighted.setAttribute('data-current', '');
  }

  function focusChoice(button, scrollPage = false) {
    if (!button) return;
    const scrollMenu = root.scrollHeight > root.clientHeight;
    button.focus({ preventScroll: scrollMenu || !scrollPage });
    if (!scrollMenu) return;
    const bounds = root.getBoundingClientRect();
    const choice = button.getBoundingClientRect();
    if (choice.top < bounds.top) root.scrollTop += choice.top - bounds.top - 4;
    else if (choice.bottom > bounds.bottom) root.scrollTop += choice.bottom - bounds.bottom + 4;
  }

  function versusTime(now = window.performance.now()) {
    return elapsed + (visibleSince === null ? 0 : Math.max(0, now - visibleSince));
  }

  function stopCountdown() {
    if (countdownFrame !== null) cancelAnimationFrame(countdownFrame);
    countdownFrame = null;
    elapsed = versusTime();
    visibleSince = null;
  }

  function paintVersus(time) {
    const upper = clamp(time / VERSUS_ENTRANCE, 0, 1);
    const lower = clamp((time - VERSUS_ENTRANCE) / VERSUS_ENTRANCE, 0, 1);
    const style = screens.versus.style;
    style.setProperty('--versus-player-slide', `${-100 * (1 - upper) ** 2}%`);
    style.setProperty('--versus-opponent-slide', `${100 * (1 - lower) ** 2}%`);
    const label = `Fight in ${Math.ceil((VERSUS_DURATION - time) / 1000)}`;
    if (count.textContent !== label) count.textContent = label;
  }

  function show(screen, focusSelector) {
    stopCountdown();
    if (current) screens[current].hidden = true;
    current = screen;
    const section = screens[screen];
    if (screen === 'versus') {
      elapsed = 0;
      paintVersus(0);
    }
    section.hidden = false;
    const target = section.querySelector(focusSelector);
    highlight(target?.matches(MENU_CHOICE) ? target : null);
    root.scrollTop = 0;
    focusChoice(target);
    updatePresentation();
    onScreenChange(screen, () => versusTime() / 1000);
  }

  function openHome() {
    show('home', '[data-action="presets"]');
  }

  function showPresets() {
    show('presets', presetId ? `[data-id="${presetId}"]` : '[data-action="preset"]');
  }

  function showRoster(nextRole) {
    role = nextRole;
    rosterTiles.dataset.role = role;
    get('roster-heading').textContent = role === 'player' ? 'Choose your wrestler' : 'Choose your opponent';
    get('picked-player').textContent = ROSTER[draft.player] || '—';
    get('picked-opponent').textContent = ROSTER[draft.opponent] || '—';
    for (const button of rosterTiles.children) {
      const id = button.dataset.id;
      button.disabled = role === 'opponent' && id === draft.player;
      button.dataset.picked = id === draft.player ? 'player' : id === draft.opponent ? 'opponent' : '';
      button.setAttribute('aria-pressed', String(id === draft[role]));
    }
    show('roster', draft[role] ? `[data-id="${draft[role]}"]` : '[data-action="fighter"]:enabled');
  }

  function showArenas() {
    for (const button of arenaTiles.children) {
      button.setAttribute('aria-pressed', String(button.dataset.id === draft.arena));
    }
    show('arenas', draft.arena ? `[data-id="${draft.arena}"]` : '[data-action="arena"]');
  }

  function start() {
    if (current !== 'versus') return;
    stopCountdown();
    screens.versus.hidden = true;
    current = null;
    onStart(matchup);
  }

  function queueCountdown() {
    if (current === 'versus' && !document.hidden && countdownFrame === null) {
      visibleSince ??= window.performance.now();
      countdownFrame = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    countdownFrame = null;
    if (current !== 'versus' || document.hidden) return;
    const time = versusTime(now);
    if (time >= VERSUS_DURATION) {
      start();
      return;
    }
    paintVersus(time);
    queueCountdown();
  }

  function updatePresentation() {
    updateBackdrop();
    if (document.hidden) stopCountdown();
    else queueCountdown();
  }

  function showVersus(selection) {
    matchup = { ...selection };
    get('versus-arena').textContent = arenas[matchup.arena].name;
    for (const side of ['player', 'opponent']) {
      const id = matchup[side];
      get(`versus-${side}-art`).replaceChildren(wrestlerSprite(id, 'versus'));
      get(`versus-${side}-name`).textContent = ROSTER[id];
    }
    show('versus', '#versus-arena');
  }

  root.addEventListener('focusin', (event) => {
    const button = event.target;
    if (screens[current]?.contains(button) && button.matches(MENU_CHOICE) && !button.disabled) highlight(button);
  });

  function back() {
    switch (current) {
      case 'settings':
        show('home', '[data-action="settings"]');
        break;
      case 'presets':
        openHome();
        break;
      case 'roster':
        if (role === 'opponent') showRoster('player');
        else show('home', '[data-action="custom"]');
        break;
      case 'arenas':
        showRoster('opponent');
        break;
      case 'versus':
        if (presetId) showPresets();
        else showArenas();
        break;
      default:
        return false;
    }
    return true;
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !current || !screens[current].contains(button) || button.disabled) return;
    const { id, action } = button.dataset;
    switch (action) {
      case 'settings':
        show('settings', '[data-action="sound"]');
        break;
      case 'presets':
        presetId = null;
        showPresets();
        break;
      case 'custom':
        presetId = null;
        draft = { player: null, opponent: null, arena: null };
        showRoster('player');
        break;
      case 'preset':
        presetId = id;
        showVersus(PRESETS[id]);
        break;
      case 'fighter':
        draft[role] = id;
        if (role === 'player') {
          if (draft.opponent === id) draft.opponent = null;
          showRoster('opponent');
        } else {
          showArenas();
        }
        break;
      case 'arena':
        draft.arena = id;
        showVersus(draft);
        break;
      case 'back':
        back();
        break;
    }
  });

  function handleKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key || event.code;
    if (key === 'Escape') {
      if (!event.repeat && back()) event.preventDefault();
      return;
    }

    const screen = screens[current];
    if (!screen) return;
    const focused = document.activeElement;
    const inScreen = screen.contains(focused);
    const noFocusedControl = focused === document.body || focused === document.documentElement;
    const entry = inScreen ? focused : noFocusedControl ? highlighted : null;
    if (!entry) return;

    if (['Enter', 'NumpadEnter', ' ', 'Space'].includes(key)) {
      if (entry.matches('button') && (event.repeat || !inScreen)) {
        event.preventDefault();
        if (!event.repeat) entry.click();
      }
      return;
    }

    if (moveChoice(entry, key, true)) event.preventDefault();
  }

  function moveChoice(entry, key, keyboard = false) {
    if (keyboard && entry.dataset.action === 'back' && key === 'ArrowDown' && highlighted) {
      focusChoice(highlighted, true);
      return true;
    }
    const direction = arrowDirections[key];
    if (!direction || !entry.matches(MENU_CHOICE)) return false;
    const grid = entry.parentElement;
    const columns = Number(grid.dataset.menuColumns);
    const [dx, dy] = direction;
    if (dx && columns === 1) return false;

    const buttons = Array.from(grid.children);
    const from = buttons.indexOf(entry);
    if (keyboard && key === 'ArrowUp' && from < columns) {
      const backButton = screens[current].querySelector('[data-action="back"]');
      if (backButton) {
        focusChoice(backButton, true);
        return true;
      }
    }

    const step = dx + dy * columns;
    for (let next = from + step; next >= 0 && next < buttons.length; next += step) {
      if (dx && Math.floor(next / columns) !== Math.floor(from / columns)) break;
      if (!buttons[next].disabled) {
        focusChoice(buttons[next], keyboard);
        break;
      }
    }
    return true;
  }

  return {
    openHome, handleKeydown, updatePresentation, back,
    move(key) { if (highlighted) moveChoice(highlighted, key); },
    confirm() { highlighted?.click(); }
  };
}
