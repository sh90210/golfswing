// Club-head tracer.
// After a clip is recorded, step through it frame by frame:
//  1. A body-tracking model (MediaPipe Pose, hidden) finds the hands and the swing timing.
//  2. The camera is still, so a background picture is built and subtracted: what's left
//     is the golfer and the club. The thick part (the golfer) is removed.
//  3. The thin piece reaching out from the hands is the club; its far end is the club head.
//  4. One sighting per frame is chosen so the head moves believably; gaps where the club is
//     a blur (around impact) are joined through the spot where the head sat at address.
(() => {
  'use strict';

  const MP_VERSION = '0.10.14';
  const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_FULL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
  const MODEL_LITE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

  const RED = '#ff3b30';
  const GREEN = '#34c759';
  const RATE = 0.5;               // playback speed while analysing

  // ---------- Pose model (loaded once, on demand) ----------
  let posePromise = null;
  let pose = null;

  function prepare() {
    if (posePromise) return posePromise;
    posePromise = (async () => {
      const mod = await import(`${MP_BASE}/vision_bundle.mjs`);
      const lib = mod.PoseLandmarker ? mod : mod.default;
      const fileset = await lib.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (model, delegate) => lib.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      const tries = [[MODEL_FULL, 'GPU'], [MODEL_FULL, 'CPU'], [MODEL_LITE, 'CPU']];
      let lastErr;
      for (const [m, d] of tries) {
        try { pose = await make(m, d); return pose; } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })();
    posePromise.catch(() => { posePromise = null; });
    return posePromise;
  }

  // For tests: plug in a fake pose source. It may read GS.tracer.currentT.
  let currentT = 0;
  let lastTs = 0;            // MediaPipe needs every timestamp to be later than the last
  let lastError = '';
  const nextTs = () => { lastTs = Math.max(Math.floor(performance.now()), lastTs + 1); return lastTs; };
  function _setPose(p) { pose = p; posePromise = Promise.resolve(p); }

  // ---------- Small helpers ----------
  const visible = (p) => p && (p.visibility === undefined || p.visibility > 0.3);
  const round = (n) => Math.round(n * 10000) / 10000;
  const once = (el, evt, ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); el.removeEventListener(evt, done); resolve(); };
    const t = setTimeout(done, ms);
    el.addEventListener(evt, done);
  });
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // ---------- Thumbnail frames while recording (cheap) ----------
  function startSampler(video, t0) {
    const vw = video.videoWidth || 720, vh = video.videoHeight || 1280;
    const TW = 240, TH = Math.round(TW * vh / vw);
    const thumbs = [];
    let last = -1, stopped = false;
    const grab = () => {
      if (stopped) return;
      const t = (performance.now() - t0) / 1000;
      if (t >= 0 && t - last >= 0.25) {
        last = t;
        try {
          const c = document.createElement('canvas');
          c.width = TW; c.height = TH;
          c.getContext('2d').drawImage(video, 0, 0, TW, TH);
          thumbs.push({ t, canvas: c });
        } catch (_) {}
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(grab);
      else requestAnimationFrame(grab);
    };
    grab();
    return {
      finish(durationSec) { stopped = true; return { thumbs, durationSec }; },
      cancel() { stopped = true; },
    };
  }

  // ---------- Per-frame measurements ----------
  function toGray(data, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    return g;
  }

  function readPose(lm, W, H) {
    if (!lm) return null;
    const pts = [15, 16, 19, 20].map((i) => lm[i]).filter(visible);
    if (!pts.length) return null;
    const hx = pts.reduce((s, p) => s + p.x, 0) / pts.length * W;
    const hy = pts.reduce((s, p) => s + p.y, 0) / pts.length * H;
    const sh = lm[11] && lm[12] ? { x: (lm[11].x + lm[12].x) / 2 * W, y: (lm[11].y + lm[12].y) / 2 * H } : null;
    const hp = lm[23] && lm[24] ? { x: (lm[23].x + lm[24].x) / 2 * W, y: (lm[23].y + lm[24].y) / 2 * H } : null;
    let S = sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
    // The torso looks short when bent over at address; a share of full height is steadier.
    const ank = [27, 28].map((i) => lm[i]).filter(visible);
    if (visible(lm[0]) && ank.length) {
      const height = Math.max(...ank.map((p) => p.y)) * H - lm[0].y * H;
      S = Math.max(S, 0.28 * height);
    }
    const elbows = [13, 14].map((i) => lm[i]).filter(visible).map((p) => ({ x: p.x * W, y: p.y * H }));
    return { hx, hy, S, elbows };
  }

  // ---------- Analysis of a recorded clip ----------
  // The clip is played through once (much faster than jumping frame to frame). Every
  // frame is kept as a small grayscale picture; the body tracker runs a few times a
  // second, which is plenty for finding the hands and the swing timing.
  // opts: { durationSec, onProgress(fraction), isCancelled() }
  async function analyzeClip(blob, opts = {}) {
    lastError = '';
    if (!pose) await prepare();
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(v);
    v.src = url;
    try {
      await once(v, 'loadeddata', 8000);
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return null;
      const W = Math.min(360, vw), H = Math.round(W * vh / vw);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const cancelled = () => opts.isCancelled && opts.isCancelled();
      const total = (isFinite(v.duration) && v.duration > 0) ? v.duration : (opts.durationSec || 4);

      const frames = [];   // { t, gray }
      const poses = [];    // { t, P }
      let lastT = -1, lastPoseT = -1, done = false;
      const grab = (t) => {
        if (done || t <= lastT + 1e-4) return;
        lastT = t;
        ctx.drawImage(v, 0, 0, W, H);
        frames.push({ t, gray: toGray(ctx.getImageData(0, 0, W, H).data, W * H) });
        if (t - lastPoseT >= 0.065) {
          lastPoseT = t;
          currentT = t;
          let lm = null;
          try {
            const res = pose.detectForVideo(canvas, nextTs());
            lm = res && res.landmarks && res.landmarks[0];
          } catch (_) {}
          const P = readPose(lm, W, H);
          if (P && P.S > 8) poses.push({ t, P });
        }
        if (opts.onProgress) opts.onProgress(Math.min(0.85, 0.85 * t / total));
      };
      await new Promise((resolve) => {
        const finish = () => { if (!done) { done = true; clearTimeout(guard); resolve(); } };
        const guard = setTimeout(finish, total * 1000 / RATE + 6000);
        v.addEventListener('ended', finish);
        v.addEventListener('error', finish);
        if (v.requestVideoFrameCallback) {
          const cb = (now, meta) => {
            if (done) return;
            if (cancelled()) return finish();
            grab(meta.mediaTime);
            v.requestVideoFrameCallback(cb);
          };
          v.requestVideoFrameCallback(cb);
        } else {
          const tick = () => {
            if (done) return;
            if (cancelled()) return finish();
            grab(v.currentTime);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
        // Half speed, so slower phones don't skip frames.
        v.playbackRate = RATE;
        const p = v.play();
        if (p && p.catch) p.catch(finish);
      });
      v.pause();
      if (cancelled()) return null;

      if (poses.length < 5) { lastError = 'nobody'; return null; }
      const win = findSwingWindow(poses);
      if (!win) { lastError = 'noswing'; return null; }

      // Keep the frames around the swing; give each one a hand position.
      const t0 = win.start - 0.2, t1 = win.end + 0.15;
      const handAt = (t) => {
        let a = poses[0], b = poses[poses.length - 1];
        for (let i = 0; i < poses.length - 1; i++) if (poses[i].t <= t && poses[i + 1].t >= t) { a = poses[i]; b = poses[i + 1]; break; }
        if (t <= poses[0].t) b = a;
        if (t >= poses[poses.length - 1].t) a = b;
        const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return { hx: a.P.hx + (b.P.hx - a.P.hx) * u, hy: a.P.hy + (b.P.hy - a.P.hy) * u, S: a.P.S };
      };
      const fine = frames.filter((f) => f.t >= t0 && f.t <= t1);
      frames.length = 0;
      if (fine.length < 12) { lastError = 'short'; return null; }
      fine.forEach((f) => { f.P = handAt(f.t); });
      await new Promise((r) => setTimeout(r, 0)); // let the screen update before the heavy part
      const out = solve(fine, W, H, win);
      if (opts.onProgress) opts.onProgress(1);
      if (!out) lastError = 'short';
      return out;
    } finally {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      URL.revokeObjectURL(url);
    }
  }

  // Find the swing from the hands: address (low, still) → top (highest) → impact (fastest, low again).
  // The backswing can be slow and the hands pause at the top, so the start is found by
  // position (hands leave the address spot), not by speed.
  function findSwingWindow(frames) {
    const pts = frames.filter((f) => f.P);
    if (pts.length < 5) return null;
    const S = median(pts.map((f) => f.P.S).filter((s) => s > 0)) || 50;
    const sp = pts.map((f, i) => (i === 0 ? 0 : Math.hypot(f.P.hx - pts[i - 1].P.hx, f.P.hy - pts[i - 1].P.hy) / S / (f.t - pts[i - 1].t)));
    // The downswing is the moment the hands drop fastest.
    const down = pts.map((f, i) => (i === 0 ? 0 : (f.P.hy - pts[i - 1].P.hy) / S / (f.t - pts[i - 1].t)));
    let iMax = 0;
    down.forEach((d, i) => { if (d > down[iMax]) iMax = i; });
    if (down[iMax] < 0.8) return null; // nobody swung (hands never dropped faster than 0.8 torso lengths per second)
    // Top of the backswing: hands highest in the 1.5 s before the fastest moment.
    let iTop = iMax;
    for (let i = iMax; i >= 0 && pts[iMax].t - pts[i].t <= 1.5; i--) if (pts[i].P.hy < pts[iTop].P.hy) iTop = i;
    // Address: hands lowest in the 3 s before the top.
    let iLow = iTop;
    for (let i = iTop; i >= 0 && pts[iTop].t - pts[i].t <= 3; i--) if (pts[i].P.hy > pts[iLow].P.hy) iLow = i;
    let iS;
    if (pts[iLow].P.hy - pts[iTop].P.hy > 0.5 * S) {
      // Takeaway = last moment before the top when the hands were still at the address spot
      // (the club head starts moving before the hands visibly do, so step one sample earlier).
      iS = iLow;
      for (let i = iTop; i >= iLow; i--) {
        if (Math.hypot(pts[i].P.hx - pts[iLow].P.hx, pts[i].P.hy - pts[iLow].P.hy) < 0.08 * S) { iS = Math.max(iLow, i - 1); break; }
      }
    } else {
      // The recording started mid-swing: fall back to "when the hands started moving".
      iS = iMax;
      while (iS > 0 && sp[iS] > 0.25) iS--;
    }
    let iE = iMax;
    while (iE < pts.length - 1 && sp[iE] > 0.12 * sp[iMax]) iE++;
    return { start: pts[iS].t, end: pts[iE].t, S };
  }

  // ---------- Image helpers (binary masks as Uint8Array of 0/1) ----------
  // Box dilate / erode with an n×n window, using running sums (fast for any n).
  function boxOp(src, W, H, n, erode) {
    const r = n >> 1, tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    const need = erode ? 2 * r + 1 : 1;
    for (let y = 0; y < H; y++) {
      const o = y * W; let sum = 0;
      for (let x = -r; x <= r; x++) sum += (x >= 0 && x < W) ? src[o + x] : (erode ? 1 : 0);
      for (let x = 0; x < W; x++) {
        tmp[o + x] = sum >= need ? 1 : 0;
        const xo = x - r, xi = x + r + 1;
        sum -= (xo >= 0 && xo < W) ? src[o + xo] : (erode ? 1 : 0);
        sum += (xi >= 0 && xi < W) ? src[o + xi] : (erode ? 1 : 0);
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += (y >= 0 && y < H) ? tmp[y * W + x] : (erode ? 1 : 0);
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum >= need ? 1 : 0;
        const yo = y - r, yi = y + r + 1;
        sum -= (yo >= 0 && yo < H) ? tmp[yo * W + x] : (erode ? 1 : 0);
        sum += (yi >= 0 && yi < H) ? tmp[yi * W + x] : (erode ? 1 : 0);
      }
    }
    return out;
  }
  const dilate = (m, W, H, n) => boxOp(m, W, H, n, false);
  const erode = (m, W, H, n) => boxOp(m, W, H, n, true);

  // Fill enclosed holes: anything not reachable from the picture border becomes 1.
  function fillHoles(m, W, H) {
    const seen = new Uint8Array(W * H), stack = [];
    const push = (i) => { if (!m[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < W * (H - 1)) push(i + W);
    }
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = seen[i] ? 0 : 1;
    return out;
  }

  // ---------- Find the club head path ----------
  // The camera is still, so anything that differs from the "empty" background is the
  // golfer or the club. The golfer is thick, the club is thin: remove the thick part and
  // what's left, reaching out from the hands, is the club; its far end is the club head.
  // Where the club is too blurred to see (around impact) the path is joined up through
  // the spot where the club head sat at address.
  function solve(frames, W, H, win) {
    const F = frames.length, N = W * H;
    const idx = frames.map((f, i) => (f.P ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 6) return null;
    // Hands: fill gaps, smooth lightly.
    const hand = frames.map((f, i) => {
      if (f.P) return [f.P.hx, f.P.hy];
      let a = idx.filter((j) => j < i).pop(), b = idx.find((j) => j > i);
      if (a === undefined) a = b;
      if (b === undefined) b = a;
      const u = a === b ? 0 : (i - a) / (b - a);
      return [frames[a].P.hx + (frames[b].P.hx - frames[a].P.hx) * u, frames[a].P.hy + (frames[b].P.hy - frames[a].P.hy) * u];
    });
    const hs = hand.map((p, i) => {
      let x = 0, y = 0, w = 0;
      for (let j = i - 1; j <= i + 1; j++) {
        if (j < 0 || j >= F) continue;
        const k = j === i ? 2 : 1; x += hand[j][0] * k; y += hand[j][1] * k; w += k;
      }
      return [x / w, y / w];
    });
    const S = median(frames.filter((f) => f.P && f.P.S > 0).map((f) => f.P.S)) || win.S;
    const odd = (v) => Math.max(3, Math.round(v) | 1);

    // 1. Background = per-pixel median of frames spread across the swing.
    const step = Math.max(1, Math.round(F / 21));
    const samples = [];
    for (let i = 0; i < F; i += step) samples.push(frames[i].gray);
    const bg = new Uint8Array(N), buf = new Uint8Array(samples.length);
    for (let p = 0; p < N; p++) {
      for (let k = 0; k < samples.length; k++) buf[k] = samples[k][p];
      buf.sort();
      bg[p] = buf[samples.length >> 1];
    }

    // 2. Foreground and body mask for each frame.
    const fgs = [], bodies = [];
    const D = new Uint8Array(N);
    for (let i = 0; i < F; i++) {
      const g = frames[i].gray;
      for (let p = 0; p < N; p++) D[p] = Math.abs(g[p] - bg[p]);
      const fg = new Uint8Array(N);
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const p = y * W + x;
          const sum = D[p - W - 1] + D[p - W] + D[p - W + 1] + D[p - 1] + D[p] + D[p + 1] + D[p + W - 1] + D[p + W] + D[p + W + 1];
          fg[p] = sum > 13 * 9 ? 1 : 0;
        }
      }
      const kc = odd(0.2 * S), ko = odd(0.15 * S), kd = odd(0.08 * S);
      const closed = erode(dilate(fg, W, H, kc), W, H, kc);
      const filled = fillHoles(closed, W, H);
      const body = dilate(dilate(erode(filled, W, H, ko), W, H, ko), W, H, kd);
      fgs.push(fg); bodies.push(body);
      frames[i].gray = null;
    }
    // Parts of the picture that are "body" much of the time (legs, torso): never the club.
    let persist = new Uint8Array(N);
    const cnt = new Uint16Array(N);
    bodies.forEach((b) => { for (let p = 0; p < N; p++) cnt[p] += b[p]; });
    for (let p = 0; p < N; p++) persist[p] = cnt[p] > 0.3 * F ? 1 : 0;
    persist = dilate(persist, W, H, odd(0.1 * S));

    // 3. Club candidates: thin moving pieces outside the body; the far end from the hands.
    const C = [];
    const lab = new Int32Array(N);
    for (let i = 0; i < F; i++) {
      const fg = fgs[i], body = bodies[i], [hx, hy] = hs[i];
      lab.fill(0);
      const out = [];
      let next = 0;
      for (let p0 = 0; p0 < N; p0++) {
        if (!fg[p0] || body[p0] || persist[p0] || lab[p0]) continue;
        next++;
        const stack = [p0], px = [];
        lab[p0] = next;
        while (stack.length) {
          const p = stack.pop(); px.push(p);
          const x = p % W, y = (p / W) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
              const q = yy * W + xx;
              if (fg[q] && !body[q] && !persist[q] && !lab[q]) { lab[q] = next; stack.push(q); }
            }
          }
        }
        if (px.length < 12) continue;
        let far = 0, near = Infinity;
        const ds = px.map((p) => {
          const d = Math.hypot((p % W) - hx, ((p / W) | 0) - hy);
          if (d > far) far = d;
          if (d < near) near = d;
          return d;
        });
        if (far < 0.45 * S || far > 3.2 * S) continue;
        let sx = 0, sy = 0, n = 0;
        px.forEach((p, k) => { if (ds[k] >= far - 4) { sx += p % W; sy += (p / W) | 0; n++; } });
        // The club head sticks out into open space; a sliver hugging the body is not it.
        const cx = Math.round(sx / n), cy = Math.round(sy / n), rr = Math.round(0.18 * S);
        let hug = false;
        for (let yy = Math.max(0, cy - rr); yy <= Math.min(H - 1, cy + rr) && !hug; yy += 2) {
          for (let xx = Math.max(0, cx - rr); xx <= Math.min(W - 1, cx + rr); xx += 2) {
            const q = yy * W + xx;
            if (body[q] || persist[q]) { hug = true; break; }
          }
        }
        out.push({ x: sx / n, y: sy / n, far, ext: far - near, hug });
      }
      out.sort((a, b) => b.ext - a.ext);
      C.push(out.slice(0, 5));
      fgs[i] = null; bodies[i] = null;
    }

    // 4. Club length (hands to head) from the clearest sightings.
    const strongFar = C.filter((c) => c.length && c[0].ext > 0.5 * S).map((c) => c[0].far).sort((a, b) => a - b);
    if (strongFar.length < 3) return null;
    const L = strongFar[Math.floor(strongFar.length * 0.75)];
    for (let i = 0; i < F; i++) C[i] = C[i].filter((c) => c.far <= 1.35 * L);
    // Something that sits in the same spot for a third of the swing isn't the club head.
    const all = [];
    C.forEach((c, i) => c.forEach((d) => all.push([i, d])));
    all.forEach(([i, d]) => {
      const seenIn = new Set();
      all.forEach(([j, e]) => { if (j !== i && Math.abs(e.x - d.x) < 6 && Math.abs(e.y - d.y) < 6) seenIn.add(j); });
      d.still = seenIn.size >= 0.3 * F;
    });
    for (let i = 0; i < F; i++) C[i] = C[i].filter((c) => !c.still);

    // 5. Swing phases from the hands.
    const speed = hs.map((p, i) => (i === 0 ? 0 : Math.hypot(p[0] - hs[i - 1][0], p[1] - hs[i - 1][1])));
    let iMax = 1;
    for (let i = 1; i < F; i++) if (hs[i][1] - hs[i - 1][1] > hs[iMax][1] - hs[iMax - 1][1]) iMax = i; // fastest downward
    let iHigh = 0;
    for (let i = 0; i <= iMax; i++) if (hs[i][1] < hs[iHigh][1]) iHigh = i;
    // The club keeps going back while the hands pause at the top, and only turns when the
    // hands start down. So the top is the END of that pause, not the first highest moment.
    let iTop = iHigh;
    for (let i = iHigh; i < iMax; i++) {
      if (hs[i][1] - hs[iHigh][1] <= 0.08 * S && Math.hypot(hs[i][0] - hs[iHigh][0], hs[i][1] - hs[iHigh][1]) <= 0.12 * S) iTop = i;
      else break;
    }
    let iImp = iMax;
    for (let i = iMax; i < F && frames[i].t - frames[iMax].t <= 0.2; i++) if (hs[i][1] > hs[iImp][1]) iImp = i;

    // Where the club head sat at address: the first clear sighting, low and early.
    let addr = null;
    for (let i = 0; i < iTop && !addr; i++) {
      const c = C[i][0];
      if (c && c.ext > 0.5 * S) { if (c.y > hs[i][1] && i < 0.5 * iTop + 2) addr = c; break; }
    }
    let iBall = iImp;
    if (addr && iImp > iTop) {
      // Around impact the club is a blur: drop half-seen pieces and pass through the ball.
      for (let i = Math.max(0, iImp - 3); i < Math.min(F, iImp + 4); i++) C[i] = C[i].filter((c) => c.far >= 0.75 * L);
      // The head reaches the ball a moment (~1/30 s) before the hands bottom out.
      while (iBall > iTop + 1 && frames[iImp].t - frames[iBall].t < 0.05) iBall--;
      C[iBall].unshift({ x: addr.x, y: addr.y, far: L, ext: L, pseudo: true });
    }

    // 6. Choose one sighting per frame (or none) so the head moves believably.
    const SKIP = 1.0, GAP = Math.max(18, Math.round(0.6 * F / Math.max(0.5, frames[F - 1].t - frames[0].t)));
    const emis = (c) => (c.pseudo ? -6 : 0.9 * (1 - Math.min(1, c.ext / (0.5 * S))) + (c.hug ? 1.2 : 0));
    const move = new Float32Array(F + 1); // cumulative allowed head travel
    for (let i = 1; i < F; i++) move[i] = move[i - 1] + 0.2 * L * (30 * Math.max(1 / 120, frames[i].t - frames[i - 1].t)) + 5 * speed[i];
    const runDP = (extra) => {
      const best = C.map((c) => new Float32Array(c.length)), bp = C.map((c) => new Array(c.length).fill(null));
      for (let k = 0; k < F; k++) {
        for (let a = 0; a < C[k].length; a++) {
          const c = C[k][a], e = emis(c) + (extra ? extra(k, c) : 0);
          let b = e + SKIP * k, p = null;
          for (let g = Math.max(0, k - GAP); g < k; g++) {
            const vmax = move[k] - move[g];
            for (let q = 0; q < C[g].length; q++) {
              const d = C[g][q];
              const dd = Math.hypot(c.x - d.x, c.y - d.y) / vmax;
              if (dd > 2) continue;
              const v = best[g][q] + e + 1.5 * dd * dd + SKIP * (k - g - 1);
              if (v < b) { b = v; p = [g, q]; }
            }
          }
          best[k][a] = b; bp[k][a] = p;
        }
      }
      let end = null;
      for (let k = 0; k < F; k++) for (let a = 0; a < C[k].length; a++) {
        const v = best[k][a] + SKIP * (F - 1 - k);
        if (!end || v < end.v) end = { v, k, a };
      }
      if (!end) return null;
      const chosen = new Map();
      for (let k = end.k, a = end.a; ;) {
        chosen.set(k, C[k][a]);
        const p = bp[k][a];
        if (!p) break;
        [k, a] = p;
      }
      return chosen;
    };
    let chosen = runDP(null);
    if (!chosen) return null;
    // Second pass: on the way down, the club head comes back close to the path it took
    // on the way up. Use the backswing path to reject look-alikes during the downswing.
    {
      const up = [...chosen.keys()].filter((k) => k <= iTop).sort((x, y) => x - y).map((k) => chosen.get(k));
      if (up.length >= 4 && iBall > iTop + 1) {
        const distToPath = (c) => {
          let best = Infinity;
          for (let i = 0; i < up.length - 1; i++) {
            const ax = up[i].x, ay = up[i].y, bx = up[i + 1].x, by = up[i + 1].y;
            const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
            const u = Math.max(0, Math.min(1, ((c.x - ax) * vx + (c.y - ay) * vy) / len2));
            const d = Math.hypot(c.x - (ax + vx * u), c.y - (ay + vy * u));
            if (d < best) best = d;
          }
          return best;
        };
        const again = runDP((k, c) => {
          if (k <= iTop || k >= iBall || c.pseudo) return 0;
          const d = distToPath(c) / (0.3 * L);
          return Math.min(2.5, d * d);
        });
        if (again) chosen = again;
      }
    }
    const ks = [...chosen.keys()].sort((a, b) => a - b);
    if (ks.length < 4) return null;

    // 7. Join the sightings into one path.
    // Where the club wasn't seen, it moves in step WITH THE HANDS: progress along the gap
    // follows how far the hands have travelled, not the clock. So the head holds still
    // while the hands pause at the top, and sweeps when they move.
    const handTravel = [0];
    for (let i = 1; i < F; i++) handTravel.push(handTravel[i - 1] + Math.hypot(hs[i][0] - hs[i - 1][0], hs[i][1] - hs[i - 1][1]));
    const raw = [];
    for (let k = ks[0], n = 0; k <= ks[ks.length - 1]; k++) {
      if (chosen.has(k)) { raw.push([chosen.get(k).x, chosen.get(k).y]); continue; }
      while (ks[n + 1] < k) n++;
      const a = ks[n], b = ks[n + 1];
      const A = chosen.get(a), B = chosen.get(b);
      const travel = handTravel[b] - handTravel[a];
      const u = travel > 0.05 * S ? (handTravel[k] - handTravel[a]) / travel : (k - a) / (b - a);
      raw.push([A.x + (B.x - A.x) * u, A.y + (B.y - A.y) * u]);
    }
    const sm = raw.map((p, i) => (i === 0 || i === raw.length - 1 ? p
      : [(raw[i - 1][0] + 2 * p[0] + raw[i + 1][0]) / 4, (raw[i - 1][1] + 2 * p[1] + raw[i + 1][1]) / 4]));
    const club = sm.map((p, n) => [round(frames[ks[0] + n].t), round(p[0] / W), round(p[1] / H)]);
    return {
      v: 5,
      start: club[0][0],
      top: round(frames[Math.max(iTop, ks[0])].t),
      impact: round(frames[iImp].t),
      end: club[club.length - 1][0],
      seen: ks.length,
      club,
    };
  }

  // ---------- Drawing ----------
  function contentRect(el, vw, vh) {
    const cw = el.clientWidth, ch = el.clientHeight;
    const s = Math.min(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  }

  // Smooth curve through points (Catmull-Rom → Bézier)
  function curve(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]);
    }
  }

  function stroke(ctx, pts, color, width, dpr) {
    if (pts.length < 2) return;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.globalAlpha = 0.35; ctx.strokeStyle = color; ctx.lineWidth = (width + 8) * dpr;   // glow
    curve(ctx, pts); ctx.stroke();
    ctx.globalAlpha = 0.5; ctx.strokeStyle = '#000'; ctx.lineWidth = (width + 2.5) * dpr; // edge
    curve(ctx, pts); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = width * dpr;            // core
    curve(ctx, pts); ctx.stroke();
  }

  function drawClub(ctx, trace, rect, tNow, width, dpr) {
    const src = trace.club || [];
    if (src.length < 2) return;
    // Interpolate the exact current point so the line moves with the club.
    const shown = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      if (p[0] <= tNow) shown.push(p);
      else {
        if (i > 0) {
          const a = src[i - 1], u = (tNow - a[0]) / (p[0] - a[0]);
          shown.push([tNow, a[1] + (p[1] - a[1]) * u, a[2] + (p[2] - a[2]) * u]);
        }
        break;
      }
    }
    if (shown.length < 2) return;
    const xy = (p) => [(rect.x + p[1] * rect.w) * dpr, (rect.y + p[2] * rect.h) * dpr];
    const back = shown.filter((p) => p[0] <= trace.top).map(xy);
    const down = shown.filter((p) => p[0] >= trace.top).map(xy);
    if (back.length && down.length) down.unshift(back[back.length - 1]);
    stroke(ctx, back, RED, width, dpr);
    stroke(ctx, down, GREEN, width, dpr);
    if (tNow < trace.end) {
      const last = xy(shown[shown.length - 1]);
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(last[0], last[1], (width / 2 + 2.5) * dpr, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawTrace(canvas, el, vw, vh, trace, tNow) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(el.clientWidth * dpr), H = Math.round(el.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!trace || !vw || !vh) return;
    drawClub(ctx, trace, contentRect(el, vw, vh), tNow, 4, dpr);
  }

  // Keep a canvas overlay in sync with a playing video. Returns a detach function.
  function attach(canvas, video, trace) {
    if (!trace || trace.v !== 5) return () => {};
    let raf = 0, alive = true;
    const tick = () => {
      if (!alive) return;
      drawTrace(canvas, video, video.videoWidth, video.videoHeight, trace, video.currentTime || 0);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    };
  }

  // Thumbnail: frame at the top of the backswing (or 40% in), optionally with the trace drawn on.
  async function makeThumbnail(sample, trace, withTrace) {
    if (!sample || !sample.thumbs.length) return null;
    const target = trace ? trace.top : sample.durationSec * 0.4;
    let pick = sample.thumbs[0];
    sample.thumbs.forEach((f) => { if (Math.abs(f.t - target) < Math.abs(pick.t - target)) pick = f; });
    const c = document.createElement('canvas');
    c.width = pick.canvas.width; c.height = pick.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(pick.canvas, 0, 0);
    if (trace && withTrace && trace.v === 5) drawClub(ctx, trace, { x: 0, y: 0, w: c.width, h: c.height }, Infinity, 2.5, 1);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.78));
  }

  window.GS = window.GS || {};
  window.GS.tracer = {
    prepare,
    get ready() { return !!pose; },
    get currentT() { return currentT; },
    // Why the last trace failed, in plain words (for the button label).
    get lastError() {
      return { nobody: 'Body not found', noswing: 'No swing found', short: 'No trace' }[lastError] || '';
    },
    startSampler,
    analyzeClip,
    attach,
    makeThumbnail,
    _setPose,
    _findSwingWindow: findSwingWindow,
  };
})();
