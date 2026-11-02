(() => {
  'use strict';

  const POLL_INTERVAL_MS = 200;
  const REWIND_WATCHDOG_MS = 2000;
  const AUTOPLAY_HINT_DELAY_MS = 4000;
  const STORAGE_KEY = 'ytSegmentLooper.lastInputs';
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const YOUTUBE_HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com',
  ]);
  // YouTube also returns these codes for some videos that don't exist, so don't blame the owner outright.
  const EMBED_BLOCKED_MESSAGE = 'This video can’t be played here. The owner may have disabled embedding, or the video may be unavailable.';
  const PLAYER_ERRORS = {
    2: 'That video ID looks invalid. Check the URL and try again.',
    5: 'This video can’t be played in the HTML5 player. Try another browser or video.',
    100: 'This video wasn’t found. It may have been removed or made private.',
    101: EMBED_BLOCKED_MESSAGE,
    150: EMBED_BLOCKED_MESSAGE,
    153: 'YouTube refused to start the player because the page origin was missing. Open this page over http(s), not as a local file.',
  };

  /* All player and loop state lives here. */
  const state = {
    player: null,
    playerReady: false,
    playerState: -1,
    apiLoading: false,
    mode: 'idle', // 'idle' | 'playing' | 'done'
    videoId: null,
    start: 0,
    end: 0,
    loopCount: 1, // Infinity when infinite mode is on
    completed: 0,
    armed: false, // true while the current loop is allowed to be counted
    lastRewindAt: 0,
    durationChecked: false,
    pollId: null,
    hintTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('form'),
    url: $('url'),
    start: $('start'),
    end: $('end'),
    loops: $('loops'),
    infinite: $('infinite'),
    startCurrent: $('start-current'),
    endCurrent: $('end-current'),
    copyLink: $('copy-link'),
    playPause: $('play-pause'),
    stop: $('stop'),
    restart: $('restart'),
    status: $('status'),
    segment: $('segment'),
    message: $('message'),
  };

  /* ---------- Pure helpers ---------- */

  /** Extracts the 11-character video ID from a URL or bare ID, or returns null. */
  function parseVideoId(url) {
    const text = String(url ?? '').trim();
    if (VIDEO_ID_RE.test(text)) return text;

    let parsed;
    try {
      parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);
    let id = null;
    if (host === 'youtu.be') {
      id = segments[0];
    } else if (YOUTUBE_HOSTS.has(host)) {
      if (segments[0] === 'watch') id = parsed.searchParams.get('v');
      else if (['shorts', 'embed', 'live', 'v'].includes(segments[0])) id = segments[1];
    }
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  /** Parses an hh:mm:ss or mm:ss timestamp into seconds, or returns null. */
  function parseTime(str) {
    const text = String(str ?? '').trim();
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return null;

    const [seconds, minutes, hours = 0] = text.split(':').map(Number).reverse();
    if (seconds > 59 || minutes > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  /** Keeps up to 6 digits and adds colons from the right: 130 -> 1:30, 13000 -> 1:30:00. */
  function maskTimeInput(text) {
    const digits = String(text ?? '').replace(/\D/g, '').slice(0, 6);
    return digits.replace(/\B(?=(\d{2})+$)/g, ':');
  }

  /** Completes a partly typed time into a full timestamp: 5 -> 00:05, 130 -> 01:30. */
  function normalizeTimeInput(text) {
    const digits = String(text ?? '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return '';
    return maskTimeInput(digits.padStart(digits.length <= 4 ? 4 : 6, '0'));
  }

  /** Formats seconds as hh:mm:ss, rounding fractions down. */
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const pad = (n) => String(n).padStart(2, '0');
    return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map(pad).join(':');
  }

  /** Checks raw form values. `values` is null unless every field is valid. */
  function validateInputs(raw = readForm()) {
    const errors = {};
    const videoId = parseVideoId(raw.url);
    const start = parseTime(raw.start);
    const end = parseTime(raw.end);
    const timeHelp = 'Use hh:mm:ss or mm:ss. Minutes and seconds must be 0–59.';

    if (videoId === null) errors.url = 'Enter a valid YouTube URL or 11-character video ID.';
    if (start === null) errors.start = `Enter a valid start time. ${timeHelp}`;
    if (end === null) errors.end = `Enter a valid end time. ${timeHelp}`;
    if (start !== null && end !== null && start >= end) errors.end = 'End time must be after the start time.';

    const loopText = String(raw.loops ?? '').trim();
    const loopCount = raw.infinite ? Infinity : Number(loopText);
    if (!raw.infinite && (!/^\d+$/.test(loopText) || loopCount < 1 || !Number.isSafeInteger(loopCount))) {
      errors.loops = 'Enter a whole number of 1 or more, or turn on Infinite.';
    }

    const ok = Object.keys(errors).length === 0;
    return { errors, values: ok ? { videoId, start, end, loopCount } : null };
  }

  /* ---------- Form ---------- */

  function readForm() {
    return {
      url: ui.url.value,
      start: ui.start.value,
      end: ui.end.value,
      loops: ui.loops.value,
      infinite: ui.infinite.checked,
    };
  }

  function fillForm(raw) {
    ui.url.value = raw.url ?? '';
    ui.start.value = normalizeTimeInput(raw.start);
    ui.end.value = normalizeTimeInput(raw.end);
    ui.loops.value = raw.loops ?? '1';
    ui.infinite.checked = Boolean(raw.infinite);
    ui.loops.disabled = ui.infinite.checked;
  }

  /** Reformats a time field as the user types, keeping the caret after the same digit. */
  function applyTimeMask(input) {
    const digitsBeforeCaret = input.value.slice(0, input.selectionStart).replace(/\D/g, '').length;
    const masked = maskTimeInput(input.value);
    input.value = masked;

    let caret = 0;
    for (let seen = 0; seen < digitsBeforeCaret && caret < masked.length; caret += 1) {
      if (masked[caret] !== ':') seen += 1;
    }
    input.setSelectionRange(caret, caret);
  }

  function normalizeTimeFields() {
    ui.start.value = normalizeTimeInput(ui.start.value);
    ui.end.value = normalizeTimeInput(ui.end.value);
  }

  function setFieldError(field, text) {
    const errorEl = $(`${field}-error`);
    errorEl.textContent = text ?? '';
    errorEl.hidden = !text;
    if (text) ui[field].setAttribute('aria-invalid', 'true');
    else ui[field].removeAttribute('aria-invalid');
  }

  /** Renders validation results. Returns true when the form is valid. */
  function showErrors(errors, { focus = true } = {}) {
    const fields = ['url', 'start', 'end', 'loops'];
    fields.forEach((field) => setFieldError(field, errors[field]));
    const firstInvalid = fields.find((field) => errors[field]);
    if (firstInvalid && focus) ui[firstInvalid].focus();
    return !firstInvalid;
  }

  /* ---------- Persistence and sharing ---------- */

  function loadStoredInputs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveInputs(raw) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    } catch {
      /* Storage can be blocked or full; remembering inputs is optional. */
    }
  }

  /** Reads ?v=ID&start=90&end=120&loops=5 (or loops=inf) into raw form values. Link times are in seconds. */
  function readQuery() {
    const params = new URLSearchParams(location.search);
    const url = params.get('v');
    if (!url) return null;

    const timeField = (name) => {
      const value = params.get(name) ?? '';
      return /^\d+$/.test(value) ? formatTime(Number(value)) : value;
    };
    const loops = params.get('loops');
    const infinite = loops === 'inf' || loops === '∞';
    return { url, start: timeField('start'), end: timeField('end'), loops: infinite ? '1' : loops ?? '1', infinite };
  }

  function buildShareUrl({ videoId, start, end, loopCount }) {
    const url = new URL(location.href);
    url.hash = '';
    url.search = new URLSearchParams({
      v: videoId,
      start: String(start),
      end: String(end),
      loops: loopCount === Infinity ? 'inf' : String(loopCount),
    }).toString();
    return url.toString();
  }

  function updateAddressBar(values) {
    try {
      history.replaceState(null, '', buildShareUrl(values));
    } catch {
      /* Some browsers refuse this on file:// pages; sharing still works via the button. */
    }
  }

  /* ---------- Rendering ---------- */

  function setMessage(text, { isError = false } = {}) {
    ui.message.textContent = text ?? '';
    ui.message.hidden = !text;
    ui.message.classList.toggle('is-error', isError);
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function isPlaybackActive() {
    return state.playerState === YT.PlayerState.PLAYING || state.playerState === YT.PlayerState.BUFFERING;
  }

  function render() {
    const hasVideo = state.videoId !== null;
    const active = state.playerReady && isPlaybackActive();

    let status = 'Ready';
    if (state.mode === 'playing') {
      const total = state.loopCount === Infinity ? '∞' : state.loopCount;
      const paused = state.playerReady && state.playerState === YT.PlayerState.PAUSED;
      status = `Loop ${state.completed + 1} of ${total}${paused ? ' (paused)' : ''}`;
    } else if (state.mode === 'done') {
      status = 'Done';
    } else if (hasVideo) {
      status = 'Stopped';
    }
    setText(ui.status, status);
    ui.status.dataset.mode = state.mode;

    ui.segment.hidden = !hasVideo;
    if (hasVideo) setText(ui.segment, `Segment ${formatTime(state.start)} → ${formatTime(state.end)}`);

    setText(ui.playPause, active ? 'Pause' : 'Play');
    ui.playPause.disabled = !hasVideo;
    ui.stop.disabled = state.mode !== 'playing';
    ui.restart.disabled = !hasVideo;
    ui.startCurrent.disabled = ui.endCurrent.disabled = !(hasVideo && state.playerReady);
  }

  /* ---------- Loop logic ----------
   *
   * The end of a loop is detected in two ways:
   *   1. The player's ENDED event, which fires when `endSeconds` is honored.
   *   2. A ~200ms poll of getCurrentTime(), because `endSeconds` can be ignored after a seekTo.
   *
   * Either can fire first, and the other may follow moments later. The `armed` flag makes sure
   * each loop counts once: counting disarms, and only seeing the playhead back inside the
   * segment re-arms. getCurrentTime() can keep reporting the old position for a moment after a
   * seek, which is why re-arming waits for a position clearly before the end.
   */

  /** How far before the end the playhead must be to count as "back inside the segment". */
  function endMargin() {
    return Math.min(1, (state.end - state.start) / 2);
  }

  /** Jumps to the start of the segment. Disarms until the playhead is confirmed back there. */
  function rewind() {
    state.armed = false;
    state.lastRewindAt = Date.now();
    state.player.seekTo(state.start, true);
    state.player.playVideo();
  }

  /** Counts the loop that just ended, then either starts the next one or finishes. */
  function completeLoop() {
    state.armed = false;
    state.completed += 1;
    if (state.completed < state.loopCount) {
      rewind();
    } else {
      state.mode = 'done';
      stopPolling();
      state.player.pauseVideo();
    }
    render();
  }

  /** One poll step: validates the duration, re-arms, and detects a passed end time. */
  function tick() {
    if (state.mode !== 'playing' || !state.playerReady) return;
    checkDuration();
    if (state.mode !== 'playing' || state.player.getPlayerState() !== YT.PlayerState.PLAYING) return;

    const time = state.player.getCurrentTime();
    if (!state.armed) {
      if (time < state.end - endMargin()) {
        state.armed = true;
      } else if (time >= state.end && Date.now() - state.lastRewindAt > REWIND_WATCHDOG_MS) {
        rewind(); // The earlier seek was lost; retry without counting a loop.
      }
    } else if (time >= state.end) {
      completeLoop();
    }
  }

  function handleEnded() {
    if (state.mode !== 'playing') return;
    checkDuration();
    if (state.mode !== 'playing') return;

    // A disarmed or early ENDED belongs to a loop that was already counted, but the player has
    // still stopped, so playback must resume without touching the counter.
    const nearEnd = state.player.getCurrentTime() >= state.end - endMargin();
    if (state.armed && nearEnd) completeLoop();
    else rewind();
  }

  function startPolling() {
    stopPolling();
    state.pollId = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    clearInterval(state.pollId);
    state.pollId = null;
  }

  /* The duration is only known after loading, so this runs from the poll and player events. */
  function checkDuration() {
    if (state.durationChecked) return;
    const duration = state.player.getDuration();
    // Right after a load, the player can still report the previous video's values.
    const loadedId = state.player.getVideoData?.()?.video_id;
    if (!(duration > 0) || (loadedId && loadedId !== state.videoId)) return;

    state.durationChecked = true;
    // Durations are fractional but displayed as whole seconds, so 3:33 is fine for a 212.4s video.
    if (state.end > Math.ceil(duration)) {
      setFieldError('end', `End time is past the end of the video (${formatTime(Math.ceil(duration))}).`);
      endSession();
      state.player.stopVideo();
      render();
    } else {
      state.end = Math.min(state.end, duration);
    }
  }

  /* ---------- Session control ---------- */

  function endSession() {
    state.mode = 'idle';
    state.completed = 0;
    state.armed = false;
    stopPolling();
    clearTimeout(state.hintTimer);
  }

  function startSession({ videoId, start, end, loopCount }) {
    endSession();
    Object.assign(state, {
      videoId, start, end, loopCount,
      mode: 'playing',
      durationChecked: false,
    });
    setMessage(null);
    if (state.playerReady) loadSegment();
    else ensurePlayer();
    render();
  }

  function loadSegment() {
    state.lastRewindAt = Date.now();
    state.player.loadVideoById({ videoId: state.videoId, startSeconds: state.start, endSeconds: state.end });
    startPolling();

    // Browsers, phones especially, may block playback that wasn't started inside the video frame.
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => {
      if (state.mode === 'playing' && !isPlaybackActive()) {
        setMessage('If the video hasn’t started, tap it to begin. Your browser may have blocked autoplay.');
      }
    }, AUTOPLAY_HINT_DELAY_MS);
  }

  function restartLoops() {
    if (state.videoId === null) return;
    if (state.mode === 'idle' || !state.playerReady) {
      startSession(state);
      return;
    }
    state.mode = 'playing';
    state.completed = 0;
    setMessage(null);
    rewind();
    startPolling();
    render();
  }

  function togglePlayPause() {
    if (state.videoId === null) return;
    if (state.mode !== 'playing') {
      restartLoops();
    } else if (state.playerReady) {
      if (isPlaybackActive()) state.player.pauseVideo();
      else state.player.playVideo();
    }
  }

  function stop() {
    if (state.mode !== 'playing') return;
    endSession();
    setMessage(null);
    if (state.playerReady) state.player.stopVideo();
    render();
  }

  /* ---------- YouTube player ---------- */

  function loadYouTubeApi() {
    if (state.apiLoading) return;
    state.apiLoading = true;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      state.apiLoading = false;
      script.remove();
      endSession();
      setMessage('Couldn’t reach YouTube. Check your connection or ad blocker, then try again.', { isError: true });
      render();
    };
    document.head.append(script);
  }

  /** Creates the player once the API is available, loading the API first if needed. */
  function ensurePlayer() {
    if (state.player) return;
    if (!window.YT || !window.YT.Player) {
      loadYouTubeApi();
      return;
    }
    const playerVars = { playsinline: 1, rel: 0 };
    if (location.protocol.startsWith('http')) playerVars.origin = location.origin;
    state.player = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars,
      events: {
        onReady: handlePlayerReady,
        onStateChange: handlePlayerStateChange,
        onError: handlePlayerError,
      },
    });
  }

  function handlePlayerReady() {
    state.playerReady = true;
    if (state.mode === 'playing') loadSegment();
    render();
  }

  function handlePlayerStateChange(event) {
    state.playerState = event.data;
    if (event.data === YT.PlayerState.ENDED) {
      handleEnded();
    } else if (event.data === YT.PlayerState.PLAYING) {
      clearTimeout(state.hintTimer);
      if (!ui.message.classList.contains('is-error')) setMessage(null);
      tick(); // Re-arms right away rather than waiting for the next poll.
    }
    render();
  }

  function handlePlayerError(event) {
    endSession();
    const text = PLAYER_ERRORS[event.data] ?? `This video couldn’t be played (error ${event.data}).`;
    setMessage(text, { isError: true });
    render();
  }

  // The API requires this exact global name; it is the only global this app creates.
  window.onYouTubeIframeAPIReady = () => {
    if (state.mode === 'playing') ensurePlayer();
    render();
  };

  /* ---------- Event wiring ---------- */

  function handleSubmit(event) {
    event.preventDefault();
    normalizeTimeFields();
    const raw = readForm();
    const { errors, values } = validateInputs(raw);
    if (!showErrors(errors)) return;

    saveInputs(raw);
    updateAddressBar(values);
    startSession(values);
    // Keeps Space from re-submitting via the still-focused Load & Play button.
    ui.playPause.focus();
  }

  async function copyShareLink() {
    normalizeTimeFields();
    const { errors, values } = validateInputs();
    if (!showErrors(errors)) return;

    const link = buildShareUrl(values);
    updateAddressBar(values);
    try {
      await navigator.clipboard.writeText(link);
      setMessage('Share link copied.');
    } catch {
      setMessage('Couldn’t copy automatically. Copy the link from your address bar instead.');
    }
  }

  function useCurrentTime(field) {
    if (!state.playerReady) return;
    ui[field].value = formatTime(state.player.getCurrentTime());
    setFieldError(field, null);
  }

  function handleKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select')) return;

    if (event.code === 'Space') {
      // Space already activates a focused button or link, so don't toggle playback as well.
      if (event.target.closest?.('button, a')) return;
      event.preventDefault();
      togglePlayPause();
    } else if (event.key === 'r' || event.key === 'R') {
      restartLoops();
    }
  }

  function init() {
    ui.form.addEventListener('submit', handleSubmit);
    ui.copyLink.addEventListener('click', copyShareLink);
    ui.playPause.addEventListener('click', togglePlayPause);
    ui.stop.addEventListener('click', stop);
    ui.restart.addEventListener('click', restartLoops);
    ui.startCurrent.addEventListener('click', () => useCurrentTime('start'));
    ui.endCurrent.addEventListener('click', () => useCurrentTime('end'));
    ui.infinite.addEventListener('change', () => {
      ui.loops.disabled = ui.infinite.checked;
      setFieldError('loops', null);
    });
    ['url', 'start', 'end', 'loops'].forEach((field) => {
      ui[field].addEventListener('input', () => setFieldError(field, null));
    });
    [ui.start, ui.end].forEach((input) => {
      input.addEventListener('input', () => applyTimeMask(input));
      input.addEventListener('blur', () => {
        input.value = normalizeTimeInput(input.value);
      });
    });
    document.addEventListener('keydown', handleKeydown);

    const shared = readQuery();
    const initial = shared ?? loadStoredInputs();
    if (initial) fillForm(initial);
    render();
    loadYouTubeApi();

    // A shared link loads right away; invalid values show their errors instead.
    if (shared) {
      const { errors, values } = validateInputs();
      if (showErrors(errors, { focus: false })) startSession(values);
    }
  }

  init();
})();
