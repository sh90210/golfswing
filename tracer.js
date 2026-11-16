// Club-head tracer.
// After a clip is recorded, step through it frame by frame:
//  1. A body-tracking model (MediaPipe Pose, hidden) finds the hands = where the club starts.
//  2. For every direction out of the hands, look for a long thin straight line (the shaft),
//     plus motion along it (for blurred downswing frames).
//  3. Calibrate the club length at address, when the club is still and clearly visible.
//  4. Pick the most consistent shaft angle over the whole swing (Viterbi / dynamic programming):
//     the shaft turns smoothly, so impossible jumps are rejected and gaps are filled.
//  5. Club head = hands + club length along that angle. Drawn as a smooth glowing curve.
(() => {
  'use strict';

  const MP_VERSION = '0.10.14';
  const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_FULL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
  const MODEL_LITE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

  const RED = '#ff3b30';
  const GREEN = '#34c759';
  const NA = 120;                 // number of shaft directions (3° apart)
  const DEG = Math.PI / 180;
  const STEP_DEG = 360 / NA;
  const CLUB_RATIO = 2.0;          // club length ÷ torso length

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
  const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
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
    const S = sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
    const elbows = [13, 14].map((i) => lm[i]).filter(visible).map((p) => ({ x: p.x * W, y: p.y * H }));
    return { hx, hy, S, elbows };
  }

  // For every direction out of the hands, measure "shaft evidence" step by step:
  // a thin line (centre clearly darker/lighter than both sides) that has moved since
  // the previous frame, or motion (for blurred downswing frames). Stored as running
  // totals so any length can be scored quickly later.
  function scoreDirections(gray, prev, W, H, P, swinging) {
    const { hx, hy, S } = P;
    const R = Math.ceil(3.0 * S);
    const cum = new Float32Array(NA * (R + 1));
    const mot = new Float32Array(NA * (R + 1));
    const at = (x, y) => gray[(y | 0) * W + (x | 0)];
    const inside = (x, y) => x >= 3 && y >= 3 && x < W - 3 && y < H - 3;
    for (let k = 0; k < NA; k++) {
      const a = k * STEP_DEG;
      const dx = Math.cos(a * DEG), dy = Math.sin(a * DEG);
      const nx = -dy, ny = dx;
      const o = k * (R + 1);
      let c1 = 0, c2 = 0, out = false;
      for (let r = 1; r <= R; r++) {
        const x = hx + dx * r, y = hy + dy * r;
        if (!out && !inside(x, y)) out = true;
        if (!out) {
          const i = (y | 0) * W + (x | 0);
          const m = prev ? Math.abs(gray[i] - prev[i]) : 0;
          const c = gray[i];
          let line = 0;
          for (let d = 2; d <= 3; d++) {
            const p1 = at(x + nx * d, y + ny * d), p2 = at(x - nx * d, y - ny * d);
            if ((c < p1 - 10 && c < p2 - 10) || (c > p1 + 10 && c > p2 + 10)) {
              if (prev && swinging) {
                const j = ((y + ny * d) | 0) * W + ((x + nx * d) | 0);
                line = Math.max(m, Math.abs(gray[j] - prev[j])) > 10 ? 1 : 0.3;
              } else line = 1;
              break;
            }
          }
          c1 += line;
          c2 += m > 22 ? 1 : 0;
        }
        cum[o + r] = c1;
        mot[o + r] = c2;
      }
    }
    return { cum, mot, R };
  }

  // ---------- Frame-by-frame analysis of a recorded clip ----------
  // opts: { fps, durationSec, onProgress(fraction), isCancelled() }
  async function analyzeClip(blob, opts = {}) {
    lastError = '';
    if (!pose) await prepare();
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = url;
    try {
      await once(v, 'loadedmetadata', 8000);
      let dur = v.duration;
      if (!isFinite(dur) || dur <= 0) {
        try { v.currentTime = 1e6; } catch (_) {}
        await once(v, 'seeked', 3000);
        dur = isFinite(v.duration) && v.duration > 0 ? v.duration : (opts.durationSec || 4);
      }
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return null;
      const W = Math.min(360, vw), H = Math.round(W * vh / vw);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const fps = Math.min(60, Math.max(15, opts.fps || 30));
      const cancelled = () => opts.isCancelled && opts.isCancelled();

      // If the model misses the body in a frame, borrow the hands from the quick scan.
      let coarseRef = null;
      const borrowPose = (t) => {
        if (!coarseRef) return null;
        const pts = coarseRef.filter((f) => f.P);
        if (pts.length < 2) return null;
        let a = pts[0], b = pts[pts.length - 1];
        for (let i = 0; i < pts.length - 1; i++) if (pts[i].t <= t && pts[i + 1].t >= t) { a = pts[i]; b = pts[i + 1]; break; }
        const u = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
        return {
          hx: a.P.hx + (b.P.hx - a.P.hx) * u,
          hy: a.P.hy + (b.P.hy - a.P.hy) * u,
          S: a.P.S || b.P.S,
          elbows: u < 0.5 ? a.P.elbows : b.P.elbows,
          borrowed: true,
        };
      };
      const measure = async (t, prevGray, swinging) => {
        v.currentTime = Math.min(t, Math.max(0, dur - 0.001));
        await once(v, 'seeked', 1500);
        ctx.drawImage(v, 0, 0, W, H);
        const gray = toGray(ctx.getImageData(0, 0, W, H).data, W * H);
        let lm = null;
        currentT = t;
        try {
          const res = pose.detectForVideo(canvas, nextTs());
          lm = res && res.landmarks && res.landmarks[0];
        } catch (_) {}
        const P = readPose(lm, W, H) || borrowPose(t);
        const f = { t, P, gray };
        if (P && P.S > 8) Object.assign(f, scoreDirections(gray, prevGray, W, H, P, swinging));
        return f;
      };

      // Pass 1: every 0.1 s, to find when the swing happens.
      const coarse = [];
      const coarseTimes = [];
      for (let t = 0.05; t < dur; t += 0.1) coarseTimes.push(t);
      for (let i = 0; i < coarseTimes.length; i++) {
        if (cancelled()) return null;
        const f = await measure(coarseTimes[i], null, false);
        f.gray = null;
        coarse.push(f);
        if (opts.onProgress) opts.onProgress(0.3 * (i + 1) / coarseTimes.length);
      }
      const seen = coarse.filter((f) => f.P).length;
      if (seen < 5) { lastError = 'nobody'; return null; }
      const win = findSwingWindow(coarse);
      if (!win) { lastError = 'noswing'; return null; }
      coarseRef = coarse;

      // Calibrate the club at address from the still frames before the takeaway.
      const calib = calibrate(coarse.filter((f) => f.t < win.start && f.cum));

      // Pass 2: every frame through the swing.
      const t0 = Math.max(0, win.start - 0.2), t1 = Math.min(dur, win.end + 0.15);
      const fine = [];
      let prev = null;
      const n = Math.max(1, Math.ceil((t1 - t0) * fps));
      for (let i = 0; i <= n; i++) {
        if (cancelled()) return null;
        const tt = t0 + i / fps;
        const f = await measure(tt, prev, tt >= win.start);
        prev = f.gray;
        f.gray = null;
        fine.push(f);
        if (opts.onProgress) opts.onProgress(0.3 + 0.7 * (i + 1) / (n + 1));
      }
      const out = solve(fine, calib, W, H, win);
      if (!out) lastError = 'short';
      return out;
    } finally {
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    }
  }

  // Hands still → moving fast → still again. Returns { start, end } in seconds.
  function findSwingWindow(frames) {
    const pts = frames.filter((f) => f.P);
    if (pts.length < 5) return null;
    const S = median(pts.map((f) => f.P.S).filter((s) => s > 0)) || 50;
    const sp = pts.map((f, i) => (i === 0 ? 0 : Math.hypot(f.P.hx - pts[i - 1].P.hx, f.P.hy - pts[i - 1].P.hy) / S / (f.t - pts[i - 1].t)));
    let iMax = 0;
    sp.forEach((s, i) => { if (s > sp[iMax]) iMax = i; });
    if (sp[iMax] < 0.8) return null; // nobody swung (hands moved < 0.8 torso lengths per second)
    let iS = iMax;
    while (iS > 0 && sp[iS] > 0.12 * sp[iMax]) iS--;
    // The takeaway can be slow: keep walking back while the hands are still moving a little.
    while (iS > 0 && sp[iS] > 0.25) iS--;
    let iE = iMax;
    while (iE < pts.length - 1 && sp[iE] > 0.12 * sp[iMax]) iE++;
    return { start: pts[iS].t, end: pts[iE].t, S };
  }

  // At address the club is still and fully visible, below the hands: find its direction.
  function calibrate(addr) {
    if (!addr.length) return null;
    let best = -1, bestV = -1;
    for (let k = 0; k < NA; k++) {
      const a = k * STEP_DEG;
      if (a < 15 || a > 165) continue;
      let v = 0;
      addr.forEach((f) => {
        const r0 = Math.round(0.3 * f.P.S), r1 = Math.min(f.R, Math.round(1.5 * f.P.S));
        v += (f.cum[k * (f.R + 1) + r1] - f.cum[k * (f.R + 1) + r0]) / Math.max(1, r1 - r0);
      });
      if (v > bestV) { bestV = v; best = k; }
    }
    return { angle: best * STEP_DEG };
  }

  // ---------- Pick the most consistent club-head path ----------
  // State = (direction, visible length). Filmed from behind, the club often points
  // nearly at the camera, so it can look short and flip direction; length matters.
  const LEN_FR = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92, 1.04];
  const NK = 72;                     // directions, 5° apart (finer isn't needed here)
  const KSTEP = 360 / NK;

  function solve(frames, calib, W, H, win) {
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
        if (j < 0 || j >= hand.length) continue;
        const k = j === i ? 2 : 1; x += hand[j][0] * k; y += hand[j][1] * k; w += k;
      }
      return [x / w, y / w];
    });
    const S = median(frames.filter((f) => f.P && f.P.S > 0).map((f) => f.P.S)) || win.S;
    const L = CLUB_RATIO * S;

    // Swing phases from the hands
    const speed = hs.map((p, i) => (i === 0 ? 0 : Math.hypot(p[0] - hs[i - 1][0], p[1] - hs[i - 1][1])));
    let iMax = 0;
    speed.forEach((s2, i) => { if (s2 > speed[iMax]) iMax = i; });
    let iStart = 0;
    for (let i = 0; i <= iMax; i++) if (frames[i].t >= win.start) { iStart = i; break; }
    let iTop = iStart;
    for (let i = iStart; i <= iMax; i++) if (hs[i][1] < hs[iTop][1]) iTop = i;
    let iImp = iMax;
    for (let i = iMax; i < hs.length && frames[i].t - frames[iMax].t <= 0.2; i++) if (hs[i][1] > hs[iImp][1]) iImp = i;
    let iEnd = hs.length - 1;
    for (let i = iImp + 2; i < hs.length; i++) if (frames[i].t >= win.end) { iEnd = i; break; }

    // Where the club head sits at address (and should return to at impact)
    const a0 = (calib ? calib.angle : 60) * DEG;
    const addrHead = [hs[0][0] + Math.cos(a0) * L, hs[0][1] + Math.sin(a0) * L];

    const NS = NK * LEN_FR.length;
    const headOf = (i, s2) => {
      const k = Math.floor(s2 / LEN_FR.length), j = s2 % LEN_FR.length;
      const a = k * KSTEP * DEG, r = LEN_FR[j] * L;
      return [hs[i][0] + Math.cos(a) * r, hs[i][1] + Math.sin(a) * r];
    };

    // How well does a shaft of this direction and length match the picture?
    const emitCost = (i) => {
      const f = frames[i];
      const out = new Float32Array(NS);
      if (!f.cum) return out; // no measurement: neutral
      const R = f.R, sc = f.P.S / S;
      const blocked = (f.P.elbows || []).map((e) => Math.atan2(e.y - f.P.hy, e.x - f.P.hx) / DEG);
      for (let k = 0; k < NK; k++) {
        const kk = Math.round(k * KSTEP / STEP_DEG) % NA;
        const o = kk * (R + 1);
        const arm = blocked.some((b) => angDiff(k * KSTEP, b) < 14);
        for (let j = 0; j < LEN_FR.length; j++) {
          const r = Math.min(R, Math.round(LEN_FR[j] * L * sc));
          const r0 = Math.min(r, Math.round(0.25 * S * sc));
          let e;
          if (LEN_FR[j] < 0.3) e = 0.2; // too short to see: no opinion
          else {
            // Direction: the upper shaft near the hands is the clearest part.
            const ru = Math.min(r, Math.round(0.65 * L * sc));
            const line = (f.cum[o + ru] - f.cum[o + r0]) / Math.max(1, ru - r0);
            // Motion along the whole club (blurred downswing frames)
            const move = (f.mot[o + r] - f.mot[o + r0]) / Math.max(1, r - r0);
            e = Math.min(1, line + 0.5 * move);
            // If the shaft line clearly carries on past this point, the club is longer than this.
            const r2 = Math.min(R, r + Math.round(0.25 * L * sc));
            if (r2 > r) e -= 0.8 * (f.cum[o + r2] - f.cum[o + r]) / (r2 - r);
            if (arm) e *= 0.3;
          }
          // Mild preference for the full club length; it only looks shorter when it points at the camera.
          out[k * LEN_FR.length + j] = -Math.log(0.06 + Math.max(0, e)) + 2.0 * Math.pow(1 - Math.min(1, LEN_FR[j]), 2);
        }
      }
      return out;
    };

    const F = frames.length;
    const emits = Array.from({ length: F }, (_, i) => emitCost(i));
    const runViterbi = (guide) => {
      let cost = Float32Array.from(emits[0]);
      for (let s2 = 0; s2 < NS; s2++) {
        const h = headOf(0, s2);
        cost[s2] += Math.pow(Math.hypot(h[0] - addrHead[0], h[1] - addrHead[1]) / (0.25 * L), 2);
      }
      const back = [null];
      let prevHeads = Array.from({ length: NS }, (_, s2) => headOf(0, s2));
      for (let i = 1; i < F; i++) {
        const em = emits[i];
        const heads = Array.from({ length: NS }, (_, s2) => headOf(i, s2));
        // The club head moves up to ~4x as fast as the hands (it's further from the pivot).
        const maxMove = 0.05 * L + 4 * speed[i];
        const next = new Float32Array(NS);
        const bp = new Int16Array(NS);
        for (let s2 = 0; s2 < NS; s2++) {
          const h = heads[s2];
          let best = Infinity, arg = 0;
          for (let q = 0; q < NS; q++) {
            const ph = prevHeads[q];
            const d = Math.hypot(h[0] - ph[0], h[1] - ph[1]) / maxMove;
            if (d > 2.5) continue;
            const c = cost[q] + 1.2 * d * d;
            if (c < best) { best = c; arg = q; }
          }
          let c = best + em[s2];
          // Before the takeaway the club is still at address.
          if (i < iStart) c += Math.pow(Math.hypot(h[0] - addrHead[0], h[1] - addrHead[1]) / (0.2 * L), 2);
          // At impact the club head is back at the ball, where it was at address.
          const di = Math.abs(i - iImp);
          if (di <= 1) c += (di === 0 ? 1 : 0.4) * Math.pow(Math.hypot(h[0] - addrHead[0], h[1] - addrHead[1]) / (0.25 * L), 2);
          if (guide && guide[i]) c += 1.0 * Math.pow(Math.hypot(h[0] - guide[i][0], h[1] - guide[i][1]) / (0.35 * L), 2);
          next[s2] = c; bp[s2] = arg;
        }
        cost = next; back.push(bp); prevHeads = heads;
      }
      let st = 0;
      for (let q = 1; q < NS; q++) if (cost[q] < cost[st]) st = q;
      const path = new Array(F);
      for (let i = F - 1; i >= 0; i--) { path[i] = st; if (i > 0) st = back[i][st]; }

      return path;
    };

    // Pass 1: picture + smoothness only.
    let path = runViterbi(null);
    // Pass 2: on the way down the club head roughly retraces its backswing path. Use the
    // backswing club position at the same hand position as a guide where the picture is blurry.
    const backHeads = [];
    for (let i = iStart; i <= iTop; i++) backHeads.push({ h: hs[i], c: headOf(i, path[i]) });
    if (backHeads.length >= 3) {
      const guide = new Array(F).fill(null);
      for (let i = iTop + 1; i <= iImp; i++) {
        let best = backHeads[0];
        backHeads.forEach((b) => {
          if (Math.hypot(b.h[0] - hs[i][0], b.h[1] - hs[i][1]) < Math.hypot(best.h[0] - hs[i][0], best.h[1] - hs[i][1])) best = b;
        });
        guide[i] = [hs[i][0] + (best.c[0] - best.h[0]), hs[i][1] + (best.c[1] - best.h[1])];
      }
      path = runViterbi(guide);
    }
    // Club head positions, lightly smoothed
    const raw = path.map((s2, i) => headOf(i, s2));
    const sm = raw.map((p, i) => {
      if (i === 0 || i === raw.length - 1) return p;
      return [(raw[i - 1][0] + 2 * p[0] + raw[i + 1][0]) / 4, (raw[i - 1][1] + 2 * p[1] + raw[i + 1][1]) / 4];
    });
    const club = [], hands = [];
    for (let i = iStart; i <= iEnd; i++) {
      club.push([round(frames[i].t), round(sm[i][0] / W), round(sm[i][1] / H)]);
      hands.push([round(frames[i].t), round(hs[i][0] / W), round(hs[i][1] / H)]);
    }
    if (club.length < 4) return null;
    return {
      v: 2,
      start: round(frames[iStart].t),
      top: round(frames[iTop].t),
      impact: round(frames[iImp].t),
      end: round(frames[iEnd].t),
      club,
      hands,
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
    if (!trace || trace.v !== 2) return () => {};
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
    if (trace && withTrace && trace.v === 2) drawClub(ctx, trace, { x: 0, y: 0, w: c.width, h: c.height }, Infinity, 2.5, 1);
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
  };
})();
