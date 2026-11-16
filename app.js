(() => {
  'use strict';

  const cloud = window.GS.cloud;
  const tracer = window.GS.tracer;
  const gallery = window.GS.gallery;

  // ---------- Settings ----------
  const DEFAULTS = {
    countdown: 3,       // seconds before recording
    record: 4,          // seconds of recording
    replays: 2,         // number of replays
    gap: 1,             // seconds between replays
    slowmo: 'off',      // 'off' | 'last' | 'all'
    slowSpeed: 0.5,     // playback rate for slow-mo replays
    quality: 720,       // 480 | 720 | 1080
    fps: 30,            // 30 | 60
    mirror: true,
    beeps: true,
    traceOn: true,      // show the club-head trace on replays
    facing: 'user',     // 'user' = front camera, 'environment' = back camera
  };
  const STORE_KEY = 'golfswing.settings.v2';
  const OLD_KEY = 'golfswing.settings.v1';

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) return { ...DEFAULTS, ...JSON.parse(saved) };
      // Carry over earlier settings, but use the new normal-speed replay default.
      const old = JSON.parse(localStorage.getItem(OLD_KEY) || '{}');
      return { ...DEFAULTS, ...old, slowmo: 'off' };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {}
  }
  let settings = loadSettings();
  const isFront = () => settings.facing !== 'environment';

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const preview = $('preview');
  const playback = $('playback');
  const traceCanvas = $('traceCanvas');
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
  const toastEl = $('toast');
  const saveBtn = $('saveBtn');
  const saveCaption = $('saveCaption');
  const galleryBtn = $('galleryBtn');
  const galleryThumb = $('galleryThumb');
  const galleryIcon = $('galleryIcon');
  const traceBtn = $('traceBtn');
  const flipBtn = $('flipBtn');

  // ---------- State ----------
  let stream = null;
  let session = null;      // { cancelled: boolean, wakers: Set<fn> }
  let recorder = null;
  let sampler = null;
  let wakeLock = null;
  let audioCtx = null;
  let swingCount = 0;
  let clip = null;         // latest recording: { blob, url, sample, trace, tracing, recordedAt, durationMs, facing, saved, row }
  let detachTrace = null;

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

  let toastTimer = null;
  function toast(text, kind = '', ms = 2600) {
    toastEl.textContent = text;
    toastEl.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
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
          facingMode: { exact: settings.facing },
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: Number(settings.fps) },
        },
      }).catch((e) => {
        // Some phones don't accept an exact camera choice; ask more loosely.
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
          return navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: settings.facing, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: Number(settings.fps) } },
          });
        }
        throw e;
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
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
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
      let startedAt = 0;
      const recordedAt = new Date();
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        recorder = null;
        const durationSec = startedAt ? (performance.now() - startedAt) / 1000 : settings.record;
        const sample = sampler ? sampler.finish(durationSec) : null;
        sampler = null;
        const blob = chunks.length ? new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] }) : null;
        resolve(blob ? { blob, sample, recordedAt, durationMs: durationSec * 1000, facing: settings.facing } : null);
      };
      rec.onstart = async () => {
        startedAt = performance.now();
        // Grab a few frames for the thumbnail (cheap). The trace is worked out after recording.
        sampler = tracer.startSampler(preview, startedAt);
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

  function stopTrace() { if (detachTrace) { detachTrace(); detachTrace = null; } }

  // Show the trace on the replay screen if it's ready and switched on.
  function showTrace() {
    stopTrace();
    if (clip && clip.trace && settings.traceOn && body.classList.contains('replaying')) {
      detachTrace = tracer.attach(traceCanvas, playback, clip.trace);
    }
  }

  function updateTraceBtn() {
    traceBtn.classList.toggle('on', !!settings.traceOn);
    traceBtn.setAttribute('aria-pressed', String(!!settings.traceOn));
    const label = traceBtn.querySelector('span');
    if (clip && clip.tracing) label.textContent = `Tracing ${Math.round((clip.progress || 0) * 100)}%`;
    else if (clip && clip.traceDone && !clip.trace) label.textContent = clip.traceError || 'No trace';
    else label.textContent = settings.traceOn ? 'Trace on' : 'Trace off';
  }

  traceBtn.addEventListener('click', () => {
    settings.traceOn = !settings.traceOn;
    saveSettings();
    updateTraceBtn();
    showTrace();
  });

  // Work out the club-head trace for a clip, frame by frame, in the background.
  let tracerWarned = false;
  function traceClip(c) {
    c.tracing = true;
    c.progress = 0;
    updateTraceBtn();
    const fps = (() => {
      const tr = stream && stream.getVideoTracks()[0];
      const fr = tr && tr.getSettings ? tr.getSettings().frameRate : 0;
      return fr || Number(settings.fps) || 30;
    })();
    c.tracePromise = tracer.analyzeClip(c.blob, {
      fps,
      durationSec: c.durationMs / 1000,
      onProgress: (p) => { c.progress = p; if (clip === c) updateTraceBtn(); },
      isCancelled: () => c.cancelled,
    }).then((trace) => {
      c.trace = trace || null;
      if (!trace) c.traceError = tracer.lastError;
    }).catch(() => {
      c.trace = null;
      if (!tracerWarned) {
        tracerWarned = true;
        toast('Couldn\'t load the swing tracer. It needs internet the first time.', 'err', 4000);
      }
    }).finally(async () => {
      c.tracing = false;
      c.traceDone = true;
      if (clip === c) { updateTraceBtn(); showTrace(); }
      // If the swing was already saved, add its trace now.
      if (c.row && c.trace) {
        try { await cloud.updateSwing(c.row.id, { trace: c.trace }); c.row.trace = c.trace; } catch (_) {}
      }
    });
  }

  async function replayClip(c, s) {
    setMode('replaying');
    updateSaveButton();
    updateTraceBtn();
    showTrace();
    const n = settings.replays;
    // Play the set number of replays. If the trace is still being worked out, keep
    // replaying until it's ready (up to ~25 s), so at least one replay shows it.
    const waitUntil = performance.now() + 25000;
    for (let i = 1; !s.cancelled; i++) {
      const withTrace = !!(c.trace && settings.traceOn);
      const slow = settings.slowmo === 'all' || (settings.slowmo === 'last' && i === n);
      const rate = slow ? Number(settings.slowSpeed) : 1;
      setStatus(i <= n ? `Replay ${i}/${n}${slow ? ' · ' + formatRate(rate) : ''}` : (c.tracing ? 'Replay · tracing…' : 'Replay · with trace'));
      await playOnce(c.url, rate, s);
      if (s.cancelled) break;
      if (i >= n) {
        const stillTracing = c.tracing && performance.now() < waitUntil;
        const traceJustArrived = !withTrace && c.trace && settings.traceOn;
        if (!stillTracing && !traceJustArrived) break;
      }
      if (settings.gap > 0) await sleep(settings.gap * 1000, s);
    }
    stopTrace();
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
    if (!tracer.ready) tracer.prepare().catch(() => {});
    const s = { cancelled: false, wakers: new Set() };
    session = s;
    body.classList.add('running');
    body.classList.remove('has-clip');
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
      const rec = await recordClip(s);
      setMode('idle');
      if (s.cancelled) { if (rec) { setClip(rec); traceClip(clip); } break; }

      if (!rec) { setStatus('Recording failed'); await sleep(1000, s); continue; }
      setClip(rec);
      traceClip(clip);
      beep(660, 0.12, 0.25);
      await replayClip(clip, s);
    }
  }

  function setClip(rec) {
    if (clip && clip.url) URL.revokeObjectURL(clip.url);
    if (clip && clip.tracing && !clip.saved && !clip.saving) clip.cancelled = true; // nobody will see it
    clip = { ...rec, url: URL.createObjectURL(rec.blob), saved: false, saving: false };
    updateSaveButton();
  }

  function stopSession() {
    const s = session;
    if (!s) return;
    s.cancelled = true;
    [...s.wakers].forEach((fn) => fn());
    s.wakers.clear();
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
    if (sampler) { sampler.cancel(); sampler = null; }
    playback.pause();
    stopTrace();
    progressFill.classList.remove('run');
    countdownEl.classList.add('hidden');
    setMode('idle');
    session = null;
    body.classList.remove('running');
    // Keep the Save button for the last swing after stopping.
    if (clip && !clip.saved) body.classList.add('has-clip');
    mainBtn.setAttribute('aria-label', 'Start');
    hint.textContent = 'Tap to start';
    setStatus('Ready');
    releaseWakeLock();
  }

  mainBtn.addEventListener('click', () => {
    if (session) stopSession(); else startSession();
  });

  retryBtn.addEventListener('click', () => startCamera());

  // ---------- Saving ----------
  function updateSaveButton() {
    const busy = !!(clip && clip.saving);
    const done = !!(clip && clip.saved);
    saveBtn.classList.toggle('busy', busy);
    saveBtn.classList.toggle('done', done);
    saveBtn.disabled = !clip || busy || done;
    saveBtn.setAttribute('aria-label', done ? 'Saved' : busy ? 'Saving' : 'Save this swing');
    saveCaption.textContent = done ? 'Saved' : busy ? 'Saving' : 'Save';
  }

  saveBtn.addEventListener('click', async () => {
    const c = clip;
    if (!c || c.saving || c.saved) return;
    if (!cloud.signedIn) {
      toast('Sign in from Swings to save', 'err', 3000);
      return;
    }
    c.saving = true;
    updateSaveButton();
    try {
      const thumb = await tracer.makeThumbnail(c.sample, c.trace, true);
      const row = await cloud.saveSwing({
        video: c.blob,
        thumb,
        recordedAt: c.recordedAt,
        durationMs: c.durationMs,
        trace: c.trace || null,
        facing: c.facing,
      });
      c.row = row;
      c.saved = true;
      // Trace still being worked out? traceClip() adds it to the saved swing when ready.
      const localThumb = thumb ? URL.createObjectURL(thumb) : null;
      gallery.addSaved(row, localThumb);
      setGalleryThumb(localThumb, true, c.facing);
      if (clip === c) toast('Saved to your swings', 'ok');
    } catch (e) {
      toast(e.auth ? 'Sign in again from Swings to save' : 'Couldn\'t save. Check your connection.', 'err', 3500);
    } finally {
      c.saving = false;
      if (clip === c) {
        updateSaveButton();
        if (c.saved && !session) body.classList.remove('has-clip');
      }
    }
  });

  // ---------- Gallery button ----------
  function setGalleryThumb(url, fresh, facing) {
    galleryBtn.classList.toggle('mirror', facing !== 'environment' && !!settings.mirror);
    if (url) {
      galleryThumb.src = url;
      galleryThumb.classList.remove('hidden');
      galleryIcon.classList.add('hidden');
    } else {
      galleryThumb.removeAttribute('src');
      galleryThumb.classList.add('hidden');
      galleryIcon.classList.remove('hidden');
    }
    galleryBtn.classList.toggle('fresh', !!fresh);
  }

  galleryBtn.addEventListener('click', () => {
    stopSession();
    galleryBtn.classList.remove('fresh');
    gallery.open();
  });

  gallery.configure({
    getSettings: () => settings,
    setSetting: (k, v) => { settings[k] = v; saveSettings(); updateTraceBtn(); },
    onChanged: (latest, url) => setGalleryThumb(latest ? url : null, false, latest && latest.facing),
  });

  async function loadLatestThumb() {
    if (!cloud.signedIn) { setGalleryThumb(null); return; }
    try {
      const latest = await cloud.latestSwing();
      if (!latest || !latest.thumb_path) { setGalleryThumb(null); return; }
      const urls = await cloud.signUrls([latest.thumb_path]);
      setGalleryThumb(urls[latest.thumb_path] || null, false, latest.facing);
    } catch (_) {}
  }

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
  function applyMirror() { body.classList.toggle('mirror', isFront() && !!settings.mirror); }

  flipBtn.addEventListener('click', async () => {
    if (session) return;
    settings.facing = isFront() ? 'environment' : 'user';
    saveSettings();
    applyMirror();
    const ok = await startCamera();
    if (ok) toast(isFront() ? 'Front camera' : 'Back camera');
  });

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
    renderAccount();
  }

  function renderAccount() {
    const s = cloud.session;
    $('accountLabel').textContent = s ? `Signed in as ${s.user_name}` : 'Not signed in';
    $('accountBtn').textContent = s ? 'Sign out' : 'Sign in';
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

  function setSetting(key, val) {
    if (settings[key] === val) return;
    settings[key] = val;
    if (cameraKeys.has(key)) cameraDirty = true;
    saveSettings();
    renderSettings();
  }

  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    const key = seg.dataset.key;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const raw = b.dataset.v;
      setSetting(key, isNaN(Number(raw)) ? raw : Number(raw));
    });
  });

  document.querySelectorAll('input[type=checkbox][data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      settings[input.dataset.key] = input.checked;
      saveSettings();
      applyMirror();
      renderSettings();
    });
  });


  $('accountBtn').addEventListener('click', async () => {
    if (cloud.signedIn) {
      await cloud.signOut();
      setGalleryThumb(null);
      renderAccount();
      toast('Signed out');
    } else {
      cloud.signIn();
    }
  });

  $('resetBtn').addEventListener('click', () => {
    if (settings.quality !== DEFAULTS.quality || settings.fps !== DEFAULTS.fps) cameraDirty = true;
    settings = { ...DEFAULTS, facing: settings.facing };
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
  const redirect = cloud.handleRedirect();
  applyMirror();
  renderSettings();
  updateSaveButton();
  startCamera();
  loadLatestThumb();
  if (redirect) {
    if (redirect.ok) {
      toast(`Signed in as ${cloud.session.user_name}`, 'ok', 3000);
      gallery.open();
    } else {
      toast(`Sign-in failed: ${redirect.message}`, 'err', 5000);
    }
  }
  updateTraceBtn();
  // Load the tracer in the background so it's ready for the first swing.
  setTimeout(() => tracer.prepare().catch(() => {}), 1500);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Exposed for automated testing only.
  window.__golfswing = {
    get settings() { return settings; },
    get swingCount() { return swingCount; },
    get clip() { return clip; },
  };
})();
