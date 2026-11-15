(() => {
  'use strict';

  // ---------- Settings ----------
  const DEFAULTS = {
    countdown: 3,     // seconds before recording
    record: 4,        // seconds of recording
    replays: 2,       // number of replays
    gap: 1,           // seconds between replays
    slowmo: 'last',   // 'off' | 'last' | 'all'
    slowSpeed: 0.5,   // playback rate for slow-mo replays
    quality: 720,     // 480 | 720 | 1080
    fps: 30,          // 30 | 60
    mirror: true,
    beeps: true,
  };
  const STORE_KEY = 'golfswing.settings.v1';

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { ...DEFAULTS, ...saved };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {}
  }
  let settings = loadSettings();

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const preview = $('preview');
  const playback = $('playback');
  const statusEl = $('status');
  const swingCountEl = $('swingCount');
  const countdownEl = $('countdown');
  const progressFill = $('progressFill');
  const mainBtn = $('mainBtn');
  const hint = $('hint');
  const message = $('message');
  const messageText = $('messageText');
  const retryBtn = $('retryBtn');
  const settingsSheet = $('settings');
  const camInfo = $('camInfo');

  // ---------- State ----------
  let stream = null;
  let session = null;      // { cancelled: boolean, wakers: Set<fn> }
  let recorder = null;
  let wakeLock = null;
  let audioCtx = null;
  let swingCount = 0;
  let currentUrl = null;

  // ---------- Helpers ----------
  function setStatus(text) { statusEl.textContent = text; }

  function setMode(mode) {
    body.classList.toggle('recording', mode === 'recording');
    body.classList.toggle('replaying', mode === 'replaying');
  }

  // Sleep that ends early if the session is stopped.
  function sleep(ms, s) {
    return new Promise((resolve) => {
      if (s && s.cancelled) return resolve();
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); if (s) s.wakers.delete(done); resolve(); }
      if (s) s.wakers.add(done);
    });
  }

  function formatRate(r) {
    return r === 0.25 ? '¼×' : r === 0.5 ? '½×' : r === 0.75 ? '¾×' : r + '×';
  }

  // ---------- Audio beeps ----------
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { audioCtx = null; }
  }
  function beep(freq, duration, volume = 0.35) {
    if (!settings.beeps || !audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    } catch (_) {}
  }

  // ---------- Screen wake lock ----------
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) {}
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  // ---------- Camera ----------
  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function startCamera() {
    stopCamera();
    mainBtn.disabled = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMessage('This browser can\'t use the camera. Open the app in Chrome over https.', false);
      return false;
    }
    const h = Number(settings.quality);
    const w = Math.round((h * 16) / 9);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: Number(settings.fps) },
        },
      });
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showMessage(
        denied
          ? 'Camera access is blocked. Allow camera for this site in Chrome (tap the icon left of the address), then try again.'
          : 'Couldn\'t start the camera. Close other apps using it and try again.',
        true
      );
      return false;
    }
    preview.srcObject = stream;
    try { await preview.play(); } catch (_) {}
    hideMessage();
    mainBtn.disabled = false;
    updateCamInfo();
    return true;
  }

  function updateCamInfo() {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getSettings) { camInfo.textContent = ''; return; }
    const s = track.getSettings();
    const fps = s.frameRate ? Math.round(s.frameRate) : '?';
    camInfo.textContent = s.width && s.height
      ? `Your camera is giving ${s.width}×${s.height} at ${fps} fps.`
      : '';
  }

  function showMessage(text, canRetry) {
    messageText.textContent = text;
    retryBtn.classList.toggle('hidden', !canRetry);
    message.classList.remove('hidden');
  }
  function hideMessage() { message.classList.add('hidden'); }

  // ---------- Recording ----------
  function pickMimeType() {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    if (!window.MediaRecorder) return null;
    for (const t of types) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
    }
    return '';
  }

  function bitrateFor(q) {
    return q >= 1080 ? 10_000_000 : q >= 720 ? 5_000_000 : 2_500_000;
  }

  function recordClip(s) {
    return new Promise((resolve) => {
      const mime = pickMimeType();
      const chunks = [];
      try {
        const opts = { videoBitsPerSecond: bitrateFor(Number(settings.quality)) };
        if (mime) opts.mimeType = mime;
        recorder = new MediaRecorder(stream, opts);
      } catch (_) {
        recorder = new MediaRecorder(stream);
      }
      const rec = recorder;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        recorder = null;
        resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' }) : null);
      };
      rec.onstart = async () => {
        const ms = settings.record * 1000;
        progressFill.classList.remove('run');
        void progressFill.offsetWidth; // restart animation
        progressFill.style.animationDuration = ms + 'ms';
        progressFill.classList.add('run');
        await sleep(ms, s);
        if (rec.state !== 'inactive') rec.stop();
      };
      rec.onerror = () => { try { rec.stop(); } catch (_) { resolve(null); } };
      rec.start(250);
    });
  }

  // ---------- Playback ----------
  function playOnce(url, rate, s) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(safety);
        playback.removeEventListener('ended', finish);
        playback.removeEventListener('error', finish);
        s.wakers.delete(finish);
        playback.pause();
        resolve();
      };
      // Safety net in case 'ended' never fires.
      const safety = setTimeout(finish, (settings.record / rate) * 1000 + 4000);
      s.wakers.add(finish);
      playback.addEventListener('ended', finish);
      playback.addEventListener('error', finish);

      playback.src = url; // reload so every replay starts cleanly from frame 0
      playback.defaultPlaybackRate = rate;
      playback.playbackRate = rate;
      const p = playback.play();
      if (p && p.catch) p.catch(finish);
      playback.playbackRate = rate;
    });
  }

  async function replayClip(blob, s) {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob);
    setMode('replaying');
    const n = settings.replays;
    for (let i = 1; i <= n && !s.cancelled; i++) {
      const slow = settings.slowmo === 'all' || (settings.slowmo === 'last' && i === n);
      const rate = slow ? Number(settings.slowSpeed) : 1;
      setStatus(`Replay ${i}/${n}${slow ? ' · ' + formatRate(rate) : ''}`);
      await playOnce(currentUrl, rate, s);
      if (i < n && settings.gap > 0) await sleep(settings.gap * 1000, s);
    }
    setMode('idle');
  }

  // ---------- Countdown ----------
  async function runCountdown(s) {
    countdownEl.classList.remove('hidden');
    for (let n = settings.countdown; n > 0 && !s.cancelled; n--) {
      setStatus('Get ready');
      countdownEl.textContent = n;
      countdownEl.classList.remove('tick');
      void countdownEl.offsetWidth;
      countdownEl.classList.add('tick');
      beep(880, 0.12);
      await sleep(1000, s);
    }
    countdownEl.classList.add('hidden');
    countdownEl.textContent = '';
  }

  // ---------- Session loop ----------
  async function startSession() {
    if (session || !stream) return;
    ensureAudio();
    requestWakeLock();
    const s = { cancelled: false, wakers: new Set() };
    session = s;
    body.classList.add('running');
    mainBtn.setAttribute('aria-label', 'Stop');
    hint.textContent = 'Tap to stop';

    while (!s.cancelled) {
      await runCountdown(s);
      if (s.cancelled) break;

      swingCount++;
      swingCountEl.textContent = `Swing ${swingCount}`;
      swingCountEl.classList.remove('hidden');
      setStatus('Recording');
      setMode('recording');
      beep(1320, 0.3, 0.45);
      const blob = await recordClip(s);
      setMode('idle');
      if (s.cancelled) break;

      if (!blob) { setStatus('Recording failed'); await sleep(1000, s); continue; }
      beep(660, 0.12, 0.25);
      await replayClip(blob, s);
    }
  }

  function stopSession() {
    const s = session;
    if (!s) return;
    s.cancelled = true;
    [...s.wakers].forEach((fn) => fn());
    s.wakers.clear();
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
    playback.pause();
    progressFill.classList.remove('run');
    countdownEl.classList.add('hidden');
    setMode('idle');
    session = null;
    body.classList.remove('running');
    mainBtn.setAttribute('aria-label', 'Start');
    hint.textContent = 'Tap to start';
    setStatus('Ready');
    releaseWakeLock();
  }

  mainBtn.addEventListener('click', () => {
    if (session) stopSession(); else startSession();
  });

  retryBtn.addEventListener('click', () => startCamera());

  // Stop when the app goes to the background; restart camera on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopSession();
      stopCamera();
    } else {
      startCamera();
    }
  });

  // ---------- Settings UI ----------
  function applyMirror() { body.classList.toggle('mirror', !!settings.mirror); }

  function renderSettings() {
    document.querySelectorAll('.row[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const min = Number(row.dataset.min), max = Number(row.dataset.max);
      const unit = row.dataset.unit;
      const v = settings[key];
      row.querySelector('.val').textContent = unit === '×' ? `${v}×` : `${v}${unit}`;
      row.querySelector('.dec').disabled = v <= min;
      row.querySelector('.inc').disabled = v >= max;
    });
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', String(settings[key]) === b.dataset.v);
      });
    });
    document.querySelectorAll('input[type=checkbox][data-key]').forEach((input) => {
      input.checked = !!settings[input.dataset.key];
    });
    // Slow-mo speed only matters when slow-mo is on.
    const speedRow = document.querySelector('.seg[data-key=slowSpeed]').closest('.row');
    speedRow.style.opacity = settings.slowmo === 'off' ? '0.4' : '1';
  }

  document.querySelectorAll('.row[data-key]').forEach((row) => {
    const key = row.dataset.key;
    const min = Number(row.dataset.min), max = Number(row.dataset.max), step = Number(row.dataset.step);
    const change = (dir) => {
      const next = Math.round((settings[key] + dir * step) * 100) / 100;
      settings[key] = Math.min(max, Math.max(min, next));
      saveSettings();
      renderSettings();
    };
    row.querySelector('.dec').addEventListener('click', () => change(-1));
    row.querySelector('.inc').addEventListener('click', () => change(1));
  });

  const cameraKeys = new Set(['quality', 'fps']);
  let cameraDirty = false;

  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    const key = seg.dataset.key;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const raw = b.dataset.v;
      const val = isNaN(Number(raw)) ? raw : Number(raw);
      if (settings[key] === val) return;
      settings[key] = val;
      if (cameraKeys.has(key)) cameraDirty = true;
      saveSettings();
      renderSettings();
    });
  });

  document.querySelectorAll('input[type=checkbox][data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      settings[input.dataset.key] = input.checked;
      saveSettings();
      applyMirror();
    });
  });

  $('resetBtn').addEventListener('click', () => {
    if (settings.quality !== DEFAULTS.quality || settings.fps !== DEFAULTS.fps) cameraDirty = true;
    settings = { ...DEFAULTS };
    saveSettings();
    renderSettings();
    applyMirror();
  });

  $('settingsBtn').addEventListener('click', () => {
    if (session) return;
    cameraDirty = false;
    renderSettings();
    updateCamInfo();
    settingsSheet.classList.remove('hidden');
  });

  $('closeSettings').addEventListener('click', async () => {
    settingsSheet.classList.add('hidden');
    if (cameraDirty) { cameraDirty = false; await startCamera(); }
  });

  // ---------- Boot ----------
  applyMirror();
  renderSettings();
  startCamera();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Exposed for automated testing only.
  window.__golfswing = { get settings() { return settings; }, get swingCount() { return swingCount; } };
})();
