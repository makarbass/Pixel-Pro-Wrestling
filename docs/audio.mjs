const TRACKS = {
  crowd: new URL('assets/crowd.mp3', import.meta.url),
  versus: new URL('assets/versus.mp3', import.meta.url)
};
const SOUND_PREFERENCE = 'pixel-pro-wrestling.sound';

function readSoundPreference() {
  try {
    return window.localStorage.getItem(SOUND_PREFERENCE) !== 'off';
  } catch {
    return true;
  }
}

export function createGameAudio() {
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  const buffers = new Map();
  let enabled = readSoundPreference();
  let context;
  let hasRun = false;
  let requestedTrack;
  let versusOffset;
  let versusFinished = false;
  let crowdOffset = 0;
  let active;

  function stop() {
    if (!active) return;
    const { name, source, startedAt } = active;
    if (name === 'crowd') {
      crowdOffset = (crowdOffset + context.currentTime - startedAt) % source.buffer.duration;
    }
    active = null;
    source.stop();
    source.disconnect();
  }

  function updatePlayback() {
    const running = context?.state === 'running';
    if (running) hasRun = true;
    const audible = enabled && !document.hidden;
    if (!audible || active?.name !== requestedTrack) stop();
    if (!audible || !requestedTrack || active || !running) return;

    const buffer = buffers.get(requestedTrack);
    if (!buffer) return;
    const isCrowd = requestedTrack === 'crowd';
    const offset = isCrowd ? crowdOffset : versusOffset();
    if (!isCrowd && (versusFinished || offset >= buffer.duration)) return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = isCrowd;
    source.connect(context.destination);
    source.onended = () => {
      if (active?.source !== source) return;
      active = null;
      versusFinished = !isCrowd;
      source.disconnect();
    };
    active = { name: requestedTrack, source, startedAt: context.currentTime };
    source.start(0, offset);
  }

  function setTrack(name, getOffset) {
    if (requestedTrack !== name) versusFinished = false;
    requestedTrack = name;
    versusOffset = getOffset;
    updatePlayback();
  }

  function setEnabled(value) {
    enabled = value;
    try {
      window.localStorage.setItem(SOUND_PREFERENCE, value ? 'on' : 'off');
    } catch {
      // Keep the current session's choice when storage is unavailable.
    }
    updatePlayback();
  }

  async function loadTrack(name, url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      buffers.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      updatePlayback();
    } catch {
      // A missing or unreadable clip must not block the game.
    }
  }

  function resumePlayback() {
    if (!enabled || !context) return;
    if (context.state === 'running') updatePlayback();
    else context.resume().then(updatePlayback, () => {});
  }

  function visibilityChanged() {
    if (document.hidden) stop();
    else if (hasRun) resumePlayback();
    else updatePlayback();
  }

  function prepare() {
    if (!enabled || !AudioContext || context) return;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    context.addEventListener('statechange', updatePlayback);
    for (const [name, url] of Object.entries(TRACKS)) loadTrack(name, url);
    updatePlayback();
  }

  function activate() {
    if (document.hidden) return;
    prepare();
    resumePlayback();
  }

  return { get enabled() { return enabled; }, activate, prepare, setEnabled, setTrack, visibilityChanged };
}
