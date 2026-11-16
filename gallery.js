// Saved swings: gallery grouped by day, and an in-app player.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cloud = () => window.GS.cloud;
  const tracer = () => window.GS.tracer;

  const galleryEl = $('gallery');
  const bodyEl = $('galleryBody');
  const countEl = $('galleryCount');

  const playerEl = $('player');
  const pVideo = $('pVideo');
  const pTrace = $('pTrace');
  const pLabel = $('pLabel');
  const pDelete = $('pDelete');
  const pPlay = $('pPlay');
  const pLoop = $('pLoop');
  const pSeek = $('pSeek');
  const pTime = $('pTime');
  const pDur = $('pDur');
  const pLoading = $('pLoading');
  const pSpeed = $('pSpeed');
  const pTraceBtn = $('pTraceBtn');
  const pTraceLabel = $('pTraceLabel');

  let rows = [];
  let thumbUrls = {};
  let thumbUrlsAt = 0;
  let current = -1;
  let detachTrace = null;
  let objectUrl = null;
  let rate = 1;
  let loop = true;
  let duration = 0;
  let deleteArmed = null;
  let loadToken = 0;
  let getSettings = () => ({ traceOn: true, mirror: true });
  let setSetting = () => {};
  let onChanged = () => {};
  let tracing = null; // { row, progress } while a saved swing is being traced
  const mirrored = (r) => (r.facing || 'user') !== 'environment' && !!getSettings().mirror;

  // ---------- Dates ----------
  function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function dayTitle(d) {
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(y)) return 'Yesterday';
    const diff = (new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function daySub(d, n) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${n}`;
  }
  function timeLabel(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtMB(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
  }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.forEach((c) => c && e.appendChild(c));
    return e;
  }

  // ---------- Gallery ----------
  async function open() {
    galleryEl.classList.remove('hidden');
    await refresh();
  }
  function close() { galleryEl.classList.add('hidden'); }

  function renderSignedOut() {
    countEl.textContent = '';
    bodyEl.replaceChildren(el('div', { class: 'g-empty' }, [
      el('strong', { text: 'Save your swings' }),
      el('span', { text: 'Sign in once with GitHub. Your swings are stored privately, and only you can see them.' }),
      el('div', {}, [el('button', { class: 'primary', onclick: () => cloud().signIn() }, [
        githubIcon(), document.createTextNode('Sign in with GitHub'),
      ])]),
    ]));
  }

  function githubIcon() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', 'M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z');
    s.appendChild(p);
    return s;
  }

  function renderMessage(title, text) {
    bodyEl.replaceChildren(el('div', { class: 'g-empty' }, [el('strong', { text: title }), el('span', { text })]));
  }

  async function refresh() {
    if (!cloud().signedIn) { renderSignedOut(); return; }
    if (!rows.length) renderMessage('Loading…', '');
    try {
      rows = await cloud().listSwings();
      if (Date.now() - thumbUrlsAt > 30 * 60 * 1000 || rows.some((r) => r.thumb_path && !thumbUrls[r.thumb_path])) {
        thumbUrls = await cloud().signUrls(rows.map((r) => r.thumb_path));
        thumbUrlsAt = Date.now();
      }
    } catch (e) {
      if (e.auth) { renderSignedOut(); return; }
      renderMessage('Couldn\'t load your swings', 'Check your internet connection and try again. If you haven\'t used the app for a week, your free Supabase project may be paused. Open supabase.com to restore it.');
      return;
    }
    render();
    onChanged(rows[0] || null, rows[0] && rows[0].thumb_path ? thumbUrls[rows[0].thumb_path] : null);
  }

  function render() {
    countEl.textContent = rows.length ? `${rows.length} clip${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length) {
      renderMessage('No saved swings yet', 'During a replay, tap Save (the cloud button) to keep that swing here.');
      return;
    }
    const groups = [];
    rows.forEach((r, i) => {
      const d = new Date(r.recorded_at);
      const k = dayKey(d);
      let g = groups[groups.length - 1];
      if (!g || g.key !== k) { g = { key: k, date: d, items: [] }; groups.push(g); }
      g.items.push({ r, i, d });
    });
    const frag = document.createDocumentFragment();
    groups.forEach((g) => {
      const grid = el('div', { class: 'grid' });
      g.items.forEach(({ r, i, d }) => {
        const btn = el('button', { class: `thumb${mirrored(r) ? ' mirror' : ''}`, 'aria-label': `Play swing from ${timeLabel(d)}`, onclick: () => play(i) });
        const url = r.thumb_path && thumbUrls[r.thumb_path];
        if (url) btn.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
        btn.appendChild(el('span', { class: 'dur', text: fmt((r.duration_ms || 0) / 1000) }));
        btn.appendChild(el('span', { class: 'time', text: timeLabel(d) }));
        grid.appendChild(btn);
      });
      frag.appendChild(el('section', { class: 'day' }, [
        el('div', { class: 'day-head' }, [el('h3', { text: dayTitle(g.date) }), el('span', { text: daySub(g.date, g.items.length) })]),
        grid,
      ]));
    });
    const total = rows.reduce((s, r) => s + (Number(r.size_bytes) || 0), 0);
    frag.appendChild(el('p', { class: 'g-foot', text: `${rows.length} swing${rows.length === 1 ? '' : 's'} · ${fmtMB(total)} MB of 1 GB used` }));
    bodyEl.replaceChildren(frag);
  }

  // ---------- Player ----------
  let blobForTrace = null;
  async function play(index) {
    if (index < 0 || index >= rows.length) return;
    current = index;
    const r = rows[index];
    const token = ++loadToken;
    playerEl.classList.remove('hidden');
    playerEl.classList.remove('controls-hidden');
    playerEl.classList.toggle('mirror', mirrored(r));
    disarmDelete();
    const d = new Date(r.recorded_at);
    pLabel.textContent = `${dayTitle(d)} · ${timeLabel(d)}`;
    stopTrace();
    pVideo.pause();
    pVideo.removeAttribute('src');
    pLoading.classList.remove('hidden');
    duration = (r.duration_ms || 0) / 1000;
    pDur.textContent = fmt(duration);
    pTime.textContent = '0:00';
    pSeek.value = 0;

    try {
      const urls = await cloud().signUrls([r.video_path], 600);
      const res = await fetch(urls[r.video_path]);
      if (!res.ok) throw new Error('download');
      const blob = await res.blob();
      blobForTrace = blob;
      if (token !== loadToken) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      pVideo.src = objectUrl;
      await waitFor(pVideo, 'loadedmetadata', 8000);
      await fixDuration();
      if (token !== loadToken) return;
    } catch (_) {
      if (token !== loadToken) return;
      pLoading.textContent = 'Couldn\'t load this swing.';
      return;
    }
    pLoading.classList.add('hidden');
    pLoading.textContent = 'Loading…';
    pVideo.loop = loop;
    pVideo.playbackRate = rate;
    pVideo.defaultPlaybackRate = rate;
    startTrace(r);
    try { await pVideo.play(); } catch (_) {}
    // Swings saved before the new tracer (or without a trace) get traced now, once.
    if (!(r.trace && r.trace.v === 2)) retrace(r, blobForTrace);
    pVideo.playbackRate = rate;
    updatePlayIcon();
  }

  function waitFor(target, evt, ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); target.removeEventListener(evt, done); resolve(); };
      const t = setTimeout(done, ms);
      target.addEventListener(evt, done);
    });
  }

  // Recorded WebM files don't store their length; this makes the browser work it out.
  async function fixDuration() {
    if (isFinite(pVideo.duration) && pVideo.duration > 0) { duration = pVideo.duration; pDur.textContent = fmt(duration); return; }
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); pVideo.removeEventListener('durationchange', check); resolve(); };
      const check = () => { if (isFinite(pVideo.duration)) done(); };
      const t = setTimeout(done, 3000);
      pVideo.addEventListener('durationchange', check);
      try { pVideo.currentTime = 1e6; } catch (_) { done(); }
    });
    if (isFinite(pVideo.duration) && pVideo.duration > 0) duration = pVideo.duration;
    try { pVideo.currentTime = 0; } catch (_) {}
    await waitFor(pVideo, 'seeked', 1500);
    pDur.textContent = fmt(duration);
  }

  function startTrace(r) {
    stopTrace();
    if (r && r.trace && r.trace.v === 2 && getSettings().traceOn) detachTrace = tracer().attach(pTrace, pVideo, r.trace);
    updateTraceLabel();
  }
  function stopTrace() { if (detachTrace) { detachTrace(); detachTrace = null; } }

  function updateTraceLabel() {
    const on = !!getSettings().traceOn;
    pTraceBtn.classList.toggle('on', on);
    pTraceBtn.setAttribute('aria-pressed', String(on));
    const r = rows[current];
    if (tracing && r && tracing.row === r) pTraceLabel.textContent = `Tracing ${Math.round(tracing.progress * 100)}%`;
    else if (r && r.traceFailed) pTraceLabel.textContent = 'No trace';
    else pTraceLabel.textContent = on ? 'Trace on' : 'Trace off';
  }

  pTraceBtn.addEventListener('click', () => {
    setSetting('traceOn', !getSettings().traceOn);
    startTrace(rows[current]);
  });

  async function retrace(r, blob) {
    if (!blob || tracing) return;
    tracing = { row: r, progress: 0 };
    updateTraceLabel();
    try {
      const trace = await tracer().analyzeClip(blob, {
        fps: 30,
        durationSec: (r.duration_ms || 4000) / 1000,
        onProgress: (p) => { if (tracing) { tracing.progress = p; updateTraceLabel(); } },
        isCancelled: () => playerEl.classList.contains('hidden'),
      });
      if (trace) {
        r.trace = trace;
        cloud().updateSwing(r.id, { trace }).catch(() => {});
      } else if (!playerEl.classList.contains('hidden')) r.traceFailed = true;
    } catch (_) {
      r.traceFailed = true;
    } finally {
      tracing = null;
      if (rows[current] === r && !playerEl.classList.contains('hidden')) startTrace(r);
    }
  }

  function closePlayer() {
    loadToken++;
    stopTrace();
    pVideo.pause();
    pVideo.removeAttribute('src');
    pVideo.load();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    playerEl.classList.add('hidden');
    disarmDelete();
  }

  function updatePlayIcon() {
    const paused = pVideo.paused;
    pPlay.classList.toggle('paused', paused);
    pPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  pPlay.addEventListener('click', () => {
    if (pVideo.paused) {
      if (duration && pVideo.currentTime >= duration - 0.05) pVideo.currentTime = 0;
      pVideo.play().catch(() => {});
    } else pVideo.pause();
  });
  pVideo.addEventListener('play', updatePlayIcon);
  pVideo.addEventListener('pause', updatePlayIcon);
  pVideo.addEventListener('ended', updatePlayIcon);
  pVideo.addEventListener('timeupdate', () => {
    pTime.textContent = fmt(pVideo.currentTime);
    if (!seeking && duration) pSeek.value = Math.round((pVideo.currentTime / duration) * 1000);
  });

  let seeking = false;
  pSeek.addEventListener('input', () => {
    seeking = true;
    pVideo.pause();
    if (duration) pVideo.currentTime = (pSeek.value / 1000) * duration;
    pTime.textContent = fmt(pVideo.currentTime);
  });
  pSeek.addEventListener('change', () => { seeking = false; });

  pSpeed.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    rate = Number(b.dataset.v);
    pSpeed.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    pVideo.defaultPlaybackRate = rate;
    pVideo.playbackRate = rate;
  });

  pLoop.addEventListener('click', () => {
    loop = !loop;
    pVideo.loop = loop;
    pLoop.classList.toggle('on', loop);
    pLoop.setAttribute('aria-pressed', String(loop));
  });

  // Delete: tap once to arm, tap again to confirm.
  function disarmDelete() {
    if (deleteArmed) clearTimeout(deleteArmed);
    deleteArmed = null;
    pDelete.classList.remove('confirm');
    pDelete.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
    pDelete.setAttribute('aria-label', 'Delete this swing');
  }
  pDelete.addEventListener('click', async () => {
    if (!deleteArmed) {
      pDelete.classList.add('confirm');
      pDelete.textContent = 'Delete?';
      pDelete.setAttribute('aria-label', 'Tap again to delete');
      deleteArmed = setTimeout(disarmDelete, 3000);
      return;
    }
    disarmDelete();
    const r = rows[current];
    if (!r) return;
    pDelete.disabled = true;
    try {
      await cloud().deleteSwing(r);
      rows.splice(current, 1);
      render();
      onChanged(rows[0] || null, rows[0] && rows[0].thumb_path ? thumbUrls[rows[0].thumb_path] : null);
      if (rows.length) play(Math.min(current, rows.length - 1));
      else closePlayer();
    } catch (_) {
      pLoading.classList.remove('hidden');
      pLoading.textContent = 'Couldn\'t delete. Check your connection.';
      setTimeout(() => { pLoading.classList.add('hidden'); pLoading.textContent = 'Loading…'; }, 2500);
    } finally {
      pDelete.disabled = false;
    }
  });

  // Tap the video to hide/show the controls, like a normal video player.
  const toggleControls = () => {
    if (swiped) { swiped = false; return; }
    playerEl.classList.toggle('controls-hidden');
  };
  pVideo.addEventListener('click', toggleControls);
  pLoading.addEventListener('click', toggleControls);
  let swiped = false;

  // Swipe between swings (left = older, right = newer)
  let touchX = null, touchY = null;
  playerEl.addEventListener('touchstart', (e) => {
    swiped = false;
    if (e.target.closest('.p-panel')) { touchX = null; return; }
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  playerEl.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 25 || Math.abs(dy) > 25) swiped = true;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && current < rows.length - 1) play(current + 1);
      if (dx > 0 && current > 0) play(current - 1);
    }
  }, { passive: true });

  $('pClose').addEventListener('click', closePlayer);
  $('galleryBack').addEventListener('click', close);

  // Let the main app know a swing was just saved so the gallery is fresh next time.
  function addSaved(row, localThumbUrl) {
    rows.unshift(row);
    if (row.thumb_path && localThumbUrl) thumbUrls[row.thumb_path] = localThumbUrl;
  }

  window.GS = window.GS || {};
  window.GS.gallery = {
    open,
    close,
    refresh,
    addSaved,
    get isOpen() { return !galleryEl.classList.contains('hidden'); },
    get playerOpen() { return !playerEl.classList.contains('hidden'); },
    closePlayer,
    configure(o) {
      if (o.getSettings) getSettings = o.getSettings;
      if (o.setSetting) setSetting = o.setSetting;
      if (o.onChanged) onChanged = o.onChanged;
    },
  };
})();
