// Minimal Supabase client (auth + storage + table) using plain fetch.
// No external library, so the app stays small and works offline for recording.
(() => {
  'use strict';

  const URL_BASE = 'https://nnuybfdyucinxffjrfup.supabase.co';
  // Publishable key: safe to be public. Security comes from the row-level rules in the database.
  const KEY = 'sb_publishable_GORpG6tKnwVA_RCjln8Brg_76cBO2Rs';
  const BUCKET = 'swings';
  const SESSION_KEY = 'golfswing.session.v1';

  let session = loadSession();
  const listeners = new Set();

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function storeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    listeners.forEach((fn) => { try { fn(session); } catch (_) {} });
  }

  function decodeJwt(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch (_) { return {}; }
  }

  function sessionFromTokens(access, refresh, expiresIn) {
    const claims = decodeJwt(access);
    const meta = (claims.user_metadata || {});
    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: Date.now() + (Number(expiresIn) || 3600) * 1000,
      user_id: claims.sub,
      user_name: meta.user_name || meta.preferred_username || meta.name || claims.email || 'You',
      avatar: meta.avatar_url || null,
    };
  }

  // After GitHub sign-in, Supabase redirects back with tokens in the URL hash.
  function handleRedirect() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!hash) return null;
    const p = new URLSearchParams(hash);
    let result = null;
    if (p.get('access_token')) {
      storeSession(sessionFromTokens(p.get('access_token'), p.get('refresh_token'), p.get('expires_in')));
      result = { ok: true };
    } else if (p.get('error')) {
      result = { ok: false, message: (p.get('error_description') || p.get('error')).replace(/\+/g, ' ') };
    }
    if (result) history.replaceState(null, '', location.pathname + location.search);
    return result;
  }

  function signIn() {
    const back = location.origin + location.pathname;
    location.href = `${URL_BASE}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(back)}`;
  }

  async function signOut() {
    const s = session;
    storeSession(null);
    if (s) {
      try {
        await fetch(`${URL_BASE}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}` },
        });
      } catch (_) {}
    }
  }

  let refreshing = null;
  async function getToken() {
    if (!session) throw authError();
    if (Date.now() < session.expires_at - 60_000) return session.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!res.ok) {
          if (res.status === 400 || res.status === 401) storeSession(null);
          throw authError();
        }
        const j = await res.json();
        storeSession(sessionFromTokens(j.access_token, j.refresh_token, j.expires_in));
        return session.access_token;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  function authError() {
    const e = new Error('Please sign in again.');
    e.auth = true;
    return e;
  }

  async function api(path, opts = {}) {
    const token = await getToken();
    const headers = { apikey: KEY, Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
    const res = await fetch(URL_BASE + path, { ...opts, headers });
    if (res.status === 401) { storeSession(null); throw authError(); }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg = j.message || j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Upload video + thumbnail, then add the table row.
  async function saveSwing({ video, thumb, recordedAt, durationMs, trace, facing }) {
    if (!session) throw authError();
    const d = recordedAt;
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const stamp = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
    const ext = (video.type || '').includes('mp4') ? 'mp4' : 'webm';
    const base = `${session.user_id}/${day}/${stamp}`;
    const videoPath = `${base}.${ext}`;
    const thumbPath = thumb ? `${base}.jpg` : null;

    await api(`/storage/v1/object/${BUCKET}/${videoPath}`, {
      method: 'POST',
      headers: { 'Content-Type': video.type || 'video/webm', 'x-upsert': 'false' },
      body: video,
    });
    if (thumb) {
      await api(`/storage/v1/object/${BUCKET}/${thumbPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
        body: thumb,
      });
    }
    const rows = await api('/rest/v1/swings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        recorded_at: d.toISOString(),
        video_path: videoPath,
        thumb_path: thumbPath,
        duration_ms: Math.round(durationMs),
        size_bytes: video.size + (thumb ? thumb.size : 0),
        mime_type: video.type || 'video/webm',
        trace: trace || null,
        facing: facing === 'environment' ? 'environment' : 'user',
      }),
    });
    return rows[0];
  }

  async function updateSwing(id, patch) {
    await api(`/rest/v1/swings?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  }

  async function listSwings() {
    return api('/rest/v1/swings?select=*&order=recorded_at.desc', { headers: { Accept: 'application/json' } });
  }

  async function latestSwing() {
    const rows = await api('/rest/v1/swings?select=*&order=recorded_at.desc&limit=1', { headers: { Accept: 'application/json' } });
    return rows[0] || null;
  }

  // Private bucket: get short-lived links for a batch of files.
  async function signUrls(paths, expiresIn = 3600) {
    const list = paths.filter(Boolean);
    if (!list.length) return {};
    const out = await api(`/storage/v1/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn, paths: list }),
    });
    const map = {};
    (out || []).forEach((o) => {
      if (o && o.signedURL && !o.error) map[o.path] = `${URL_BASE}/storage/v1${o.signedURL}`;
    });
    return map;
  }

  async function deleteSwing(row) {
    await api(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [row.video_path, row.thumb_path].filter(Boolean) }),
    });
    await api(`/rest/v1/swings?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE' });
  }

  window.GS = window.GS || {};
  window.GS.cloud = {
    handleRedirect,
    signIn,
    signOut,
    get session() { return session; },
    get signedIn() { return !!session; },
    onChange(fn) { listeners.add(fn); },
    saveSwing,
    updateSwing,
    listSwings,
    latestSwing,
    signUrls,
    deleteSwing,
  };
})();
