export function bindFullscreen(button, state, installHint, status, mobile, onChange) {
  const installedMode = window.matchMedia('(display-mode: standalone)');
  let pending = false;

  function update() {
    const available = document.fullscreenEnabled &&
      typeof document.documentElement.requestFullscreen === 'function' &&
      typeof document.exitFullscreen === 'function';
    const installed = installedMode.matches || window.navigator.standalone === true;
    const active = Boolean(document.fullscreenElement);
    button.hidden = installed || (!active && (!available || !mobile.matches));
    button.disabled = button.hidden;
    button.setAttribute('aria-pressed', String(active));
    state.textContent = active ? 'On' : 'Off';
    installHint.hidden = installed || available || !mobile.matches;
  }

  button.addEventListener('click', async () => {
    if (pending || button.disabled) return;
    pending = true;
    status.textContent = '';
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      status.textContent = 'Could not change fullscreen mode.';
    } finally {
      pending = false;
      update();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    status.textContent = '';
    update();
    onChange();
  });
  mobile.addEventListener('change', update);
  installedMode.addEventListener('change', update);
  update();
}
