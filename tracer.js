// Swing tracer: body tracking (MediaPipe Pose) for the hand path, plus a
// motion-based estimate of the club head. Runs live while the clip records.
(() => {
  'use strict';

  const MP_VERSION = '0.10.14';
  const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

  const RED = '#ff3b30';
  const GREEN = '#34c759';

  // ---------- Pose model (loaded once, on demand) ----------
  let posePromise = null;
  let pose = null;

  function prepare() {
    if (posePromise) return posePromise;
    posePromise = (async () => {
      const mod = await import(`${MP_BASE}/vision_bundle.mjs`);
      const lib = mod.PoseLandmarker ? mod : mod.default;
      const fileset = await lib.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) => lib.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      try { pose = await make('GPU'); } catch (_) { pose = await make('CPU'); }
      return pose;
    })();
    posePromise.catch(() => { posePromise = null; });
    return posePromise;
  }

  // Allow tests to plug in a fake pose source.
  function _setPose(p) { pose = p; posePromise = Promise.resolve(p); }

  // ---------- Helpers ----------
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const visible = (p) => p && (p.visibility === undefined || p.visibility > 0.3);
  const round = (n) => Math.round(n * 10000) / 10000;

  function onFrames(video, cb) {
    let stopped = false;
    if (video.requestVideoFrameCallback) {
      const loop = (now) => { if (stopped) return; cb(now); video.requestVideoFrameCallback(loop); };
      video.requestVideoFrameCallback(loop);
    } else {
      const loop = (now) => { if (stopped) return; cb(now); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    return () => { stopped = true; };
  }

  // ---------- Live analysis while recording ----------
  // opts: { hands: bool, club: bool }
  function startAnalysis(video, t0, opts) {
    const vw = video.videoWidth || 720;
    const vh = video.videoHeight || 1280;
    const wantPose = opts.hands || opts.club;

    // Small frames for thumbnails
    const TW = 240, TH = Math.round(TW * vh / vw);
    const thumbs = [];
    let lastThumbT = -1;

    // Tiny grayscale frames for motion (club head)
    const MW = 200, MH = Math.round(MW * vh / vw);
    const mCanvas = document.createElement('canvas');
    mCanvas.width = MW; mCanvas.height = MH;
    const mCtx = mCanvas.getContext('2d', { willReadFrequently: true });
    let prevGray = null;
    let prevAngle = null;

    const hands = [];   // [t, x, y] normalized
    const club = [];    // [t, x, y] normalized
    const scales = [];  // torso length in motion-canvas px
    let lastTs = 0;

    const stop = onFrames(video, (now) => {
      const t = (performance.now() - t0) / 1000;
      if (t < 0) return;

      if (t - lastThumbT >= 0.25) {
        lastThumbT = t;
        try {
          const c = document.createElement('canvas');
          c.width = TW; c.height = TH;
          c.getContext('2d').drawImage(video, 0, 0, TW, TH);
          thumbs.push({ t, canvas: c });
        } catch (_) {}
      }

      if (!wantPose || !pose) return;

      let lm = null;
      try {
        let ts = performance.now();
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        const res = pose.detectForVideo(video, ts);
        lm = res && res.landmarks && res.landmarks[0];
      } catch (_) { lm = null; }
      if (!lm) { prevGray = null; return; }

      const lw = lm[15], rw = lm[16];
      if (!visible(lw) && !visible(rw)) { prevGray = null; return; }
      const h = visible(lw) && visible(rw) ? mid(lw, rw) : (visible(lw) ? lw : rw);
      hands.push([t, h.x, h.y]);

      if (!opts.club) return;

      // Motion map
      let gray;
      try {
        mCtx.drawImage(video, 0, 0, MW, MH);
        const data = mCtx.getImageData(0, 0, MW, MH).data;
        gray = new Uint8Array(MW * MH);
        for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
          gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        }
      } catch (_) { return; }

      const sh = mid(lm[11], lm[12]);
      const hp = mid(lm[23], lm[24]);
      const S = Math.hypot((sh.x - hp.x) * MW, (sh.y - hp.y) * MH);
      if (S > 5) scales.push(S);

      if (prevGray && S > 5) {
        const p = findClubHead(prevGray, gray, MW, MH, h.x * MW, h.y * MH, sh.x * MW, sh.y * MH, S, prevAngle);
        if (p) {
          prevAngle = p.angle;
          club.push([t, p.x / MW, p.y / MH]);
        }
      }
      prevGray = gray;
    });

    return {
      finish(durationSec) {
        stop();
        const trace = (wantPose && hands.length >= 8) ? buildTrace(hands, club, vw, vh, median(scales) / MW) : null;
        return { trace, thumbs, vw, vh, durationSec };
      },
      cancel() { stop(); },
    };
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // Look for the moving shaft/club head: the ray from the hands with the most
  // motion along it, preferring a direction close to the previous frame's.
  function findClubHead(prev, cur, W, H, hx, hy, sx, sy, S, prevAngle) {
    const THR = 28;
    const moving = (x, y) => {
      const xi = x | 0, yi = y | 0;
      if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = (yi + dy) * W + xi + dx;
          if (Math.abs(cur[k] - prev[k]) > THR) return true;
        }
      }
      return false;
    };
    const shoulderAngle = Math.atan2(sy - hy, sx - hx);
    const rMin = 0.5 * S, rMax = 2.6 * S;
    let best = null;
    for (let k = 0; k < 72; k++) {
      const a = (k * 5 * Math.PI) / 180;
      let dA = Math.abs(a - shoulderAngle) % (2 * Math.PI);
      if (dA > Math.PI) dA = 2 * Math.PI - dA;
      if (dA < (35 * Math.PI) / 180) continue; // that's the arms, not the club
      const dx = Math.cos(a), dy = Math.sin(a);
      let hits = 0, far = -1;
      for (let r = rMin; r <= rMax; r += 1) {
        const x = hx + dx * r, y = hy + dy * r;
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        if (moving(x, y)) { hits++; far = r; }
      }
      let score = hits;
      if (prevAngle !== null) {
        let d = Math.abs(a - prevAngle) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        const sigma = (50 * Math.PI) / 180;
        score *= 0.35 + 0.65 * Math.exp(-(d * d) / (2 * sigma * sigma));
      }
      if (!best || score > best.score) best = { score, a, far, dx, dy };
    }
    if (!best || best.score < 0.18 * S || best.far < 0) return null;
    const r = Math.min(rMax, Math.max(0.9 * S, best.far));
    return { x: hx + best.dx * r, y: hy + best.dy * r, angle: best.a };
  }

  function smooth(points, win = 1) {
    return points.map((p, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j++) {
        sx += points[j][1]; sy += points[j][2]; n++;
      }
      return [p[0], sx / n, sy / n];
    });
  }

  // Turn raw points into a clean trace: find takeaway, top and impact.
  function buildTrace(handsRaw, clubRaw, vw, vh, scaleNorm) {
    const asp = vw / vh; // compare distances in real pixel proportions
    const dist = (a, b) => Math.hypot((a[1] - b[1]) * asp, a[2] - b[2]);
    const hands = smooth(handsRaw, 1);

    const speed = hands.map((p, i) => {
      if (i === 0) return 0;
      const dt = Math.max(1e-3, p[0] - hands[i - 1][0]);
      return dist(p, hands[i - 1]) / dt;
    });
    let iMax = 0;
    speed.forEach((s, i) => { if (s > speed[iMax]) iMax = i; });
    const vMax = speed[iMax];
    if (vMax <= 0) return null;

    // Takeaway: first sustained movement before the fastest point
    let iStart = 0;
    for (let i = 1; i <= iMax; i++) {
      if (speed[i] > 0.12 * vMax) { iStart = Math.max(0, i - 2); break; }
    }
    // Top of backswing: hands highest (smallest y) between takeaway and fastest point
    let iTop = iStart;
    for (let i = iStart; i <= iMax; i++) if (hands[i][2] < hands[iTop][2]) iTop = i;
    // Impact: hands lowest within 0.25 s after the fastest point
    let iImp = iMax;
    for (let i = iMax; i < hands.length && hands[i][0] - hands[iMax][0] <= 0.25; i++) {
      if (hands[i][2] > hands[iImp][2]) iImp = i;
    }
    if (iTop <= iStart || iImp <= iTop) {
      // Not a recognisable swing (e.g. nobody swung) – keep it simple
      if (iImp <= iStart) return null;
    }

    const tStart = hands[iStart][0];
    const tTop = hands[iTop][0];
    const tEnd = hands[iImp][0] + 0.03;

    // Club: keep points within the swing, drop jumps, then smooth
    let club = clubRaw.filter((p) => p[0] >= tStart && p[0] <= tEnd + 0.04);
    const S = scaleNorm || 0.15;
    club = club.filter((p, i) => {
      const nb = club.slice(Math.max(0, i - 2), Math.min(club.length, i + 3)).filter((q) => q !== p);
      if (nb.length < 2) return true;
      const mx = median(nb.map((q) => q[1])), my = median(nb.map((q) => q[2]));
      return Math.hypot((p[1] - mx) * asp, p[2] - my) < 1.1 * S;
    });
    club = smooth(club, 1);

    const pack = (arr) => arr.map((p) => [round(p[0]), round(p[1]), round(p[2])]);
    return {
      v: 1,
      start: round(tStart),
      top: round(tTop),
      end: round(tEnd),
      hands: pack(hands.filter((p) => p[0] >= tStart && p[0] <= tEnd)),
      club: club.length >= 4 ? pack(club) : [],
    };
  }

  // ---------- Drawing ----------
  function contentRect(el, vw, vh) {
    const cw = el.clientWidth, ch = el.clientHeight;
    const s = Math.min(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  }

  function drawPath(ctx, pts, rect, tNow, tTop, width, alpha, dpr) {
    const shown = pts.filter((p) => p[0] <= tNow);
    if (shown.length < 2) return;
    const xy = (p) => [(rect.x + p[1] * rect.w) * dpr, (rect.y + p[2] * rect.h) * dpr];
    const seg = (list, color) => {
      if (list.length < 2) return;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.globalAlpha = alpha * 0.45;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = (width + 3) * dpr;
      ctx.beginPath();
      list.forEach((p, i) => { const [x, y] = xy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath();
      list.forEach((p, i) => { const [x, y] = xy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    const back = shown.filter((p) => p[0] <= tTop);
    const down = shown.filter((p) => p[0] >= tTop);
    if (back.length && down.length) down.unshift(back[back.length - 1]);
    seg(back, RED);
    seg(down, GREEN);
    // Current position marker
    const last = xy(shown[shown.length - 1]);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(last[0], last[1], (width / 2 + 2) * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawTrace(canvas, rectEl, vw, vh, trace, tNow, opts) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(rectEl.clientWidth * dpr), H = Math.round(rectEl.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!trace || !vw || !vh) return;
    const rect = contentRect(rectEl, vw, vh);
    if (opts.hands && trace.hands) drawPath(ctx, trace.hands, rect, tNow, trace.top, 3, 0.85, dpr);
    if (opts.club && trace.club && trace.club.length) drawPath(ctx, trace.club, rect, tNow, trace.top, 5, 1, dpr);
  }

  // Keep a canvas overlay in sync with a playing video.
  function attach(canvas, video, trace, opts) {
    let raf = 0, alive = true;
    const tick = () => {
      if (!alive) return;
      drawTrace(canvas, video, video.videoWidth, video.videoHeight, trace, video.currentTime || 0, opts);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }

  // Pick a thumbnail frame (top of backswing if known) and draw the full trace on it.
  async function makeThumbnail(result, opts) {
    const { thumbs, trace, durationSec } = result;
    if (!thumbs.length) return null;
    const target = trace ? trace.top : durationSec * 0.4;
    let pick = thumbs[0];
    thumbs.forEach((f) => { if (Math.abs(f.t - target) < Math.abs(pick.t - target)) pick = f; });
    const c = document.createElement('canvas');
    c.width = pick.canvas.width; c.height = pick.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(pick.canvas, 0, 0);
    if (trace && (opts.hands || opts.club)) {
      const overlay = document.createElement('canvas');
      drawTraceFixed(overlay, { clientWidth: c.width, clientHeight: c.height }, trace, opts);
      ctx.drawImage(overlay, 0, 0);
    }
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.75));
  }

  function drawTraceFixed(canvas, box, trace, opts) {
    canvas.width = box.clientWidth; canvas.height = box.clientHeight;
    const ctx = canvas.getContext('2d');
    const rect = { x: 0, y: 0, w: box.clientWidth, h: box.clientHeight };
    if (opts.hands && trace.hands) drawPath(ctx, trace.hands, rect, Infinity, trace.top, 2, 0.85, 1);
    if (opts.club && trace.club && trace.club.length) drawPath(ctx, trace.club, rect, Infinity, trace.top, 3, 1, 1);
  }

  window.GS = window.GS || {};
  window.GS.tracer = {
    prepare,
    get ready() { return !!pose; },
    startAnalysis,
    attach,
    makeThumbnail,
    _setPose,
    _buildTrace: buildTrace,
    _findClubHead: findClubHead,
  };
})();
