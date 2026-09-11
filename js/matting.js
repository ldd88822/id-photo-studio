// 抠图引擎：MediaPipe ImageSegmenter（人像分割）+ BlazeFace（人脸定位）
// 全部资源本地化，无外网依赖；若模型不可用，自动降级为纯色背景抠图。

let vision = null;
let fileset = null;
let segmenter = null;
let faceDetector = null;
let initPromise = null;
let lastError = null;

const VENDOR = new URL('../vendor/', import.meta.url).href;

// wasm 体积 9.4MB，弱网（GitHub Pages 国内约 43 KB/s）可达 2 分钟以上。
// 单独给 wasm 一个长超时，避免整体卡死无反馈。
const WASM_TIMEOUT_MS = 180000;

// vendor/wasm/vision_wasm_internal.wasm 解压后的真实字节数（换 wasm 时要同步更新）
const WASM_DECODED_SIZE = 9423986;

let onProgress = null;
/** 注册初始化进度回调：(phase, detail) => void */
export function setProgressHandler(fn) {
  onProgress = fn;
}
function emit(phase, detail) {
  try {
    if (onProgress) onProgress(phase, detail);
  } catch (e) {
    /* 回调异常不影响主流程 */
  }
}

/**
 * 预取 wasm 并上报下载进度。
 * 注意：MediaPipe 的 FilesetResolver 会自行下载 wasm，无法复用我们的 blob，
 * 因此这里仅在「首次访问 / 无 Service Worker 缓存」时做一次轻量探测，
 * 目的是拿到真实下载速度并给用户进度反馈，不落地 blob（避免重复占内存）。
 * 探测失败不抛错，交回 MediaPipe 自行处理。
 */
async function probeWasmSpeed() {
  const url = VENDOR + 'wasm/vision_wasm_internal.wasm';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WASM_TIMEOUT_MS);
    const t0 = Date.now();
    const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // total 不能用 content-length：线上走 gzip 时它是压缩后大小（约 2.9MB），
    // 而 getReader() 读出来的是解压后数据（9.4MB），会导致百分比卡在 99% 且显示「8.9/2.8 MB」。
    // 因此以 wasm 解压后的真实字节数为基准，取两者较大值兜底。
    const cl = Number(res.headers.get('content-length')) || 0;
    const total = cl >= WASM_DECODED_SIZE ? cl : WASM_DECODED_SIZE;
    if (!res.body || !res.body.getReader) {
      clearTimeout(timer);
      return { total, kbps: 0, ms: Date.now() - t0 };
    }
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      const pct = Math.min(99, Math.floor((got / total) * 100));
      const secs = (Date.now() - t0) / 1000;
      const kbps = secs > 0 ? Math.round(got / 1024 / secs) : 0;
      emit('download', { pct, got: Math.min(got, total), total, kbps });
    }
    clearTimeout(timer);
    emit('download', { pct: 100, got: total, total, kbps: 0 });
    return { total, ms: Date.now() - t0 };
  } catch (e) {
    emit('download-failed', { message: String((e && e.message) || e) });
    return null;
  }
}

async function loadVision() {
  if (vision) return vision;
  emit('loading-bundle', {});
  vision = await import(new URL('../vendor/vision_bundle.mjs', import.meta.url).href);
  fileset = fileset || (await vision.FilesetResolver.forVisionTasks(VENDOR + 'wasm'));
  return vision;
}

export async function initMatting(force) {
  if (force) {
    // 手动重试：清掉上一次失败的缓存，允许重新走一遍
    initPromise = null;
    lastError = null;
    segmenter = null;
    faceDetector = null;
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    lastError = null;
    emit('prefetch', {});
    await probeWasmSpeed();
    emit('parsing', {});
    const v = await loadVision();
    // 人像分割：优先 GPU，失败回退 CPU
    for (const delegate of ['GPU', 'CPU']) {
      try {
        segmenter = await v.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: VENDOR + 'selfie_segmenter.tflite', delegate },
          runningMode: 'IMAGE',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        break;
      } catch (e) {
        segmenter = null;
        lastError = String((e && e.message) || e);
      }
    }
    // 人脸检测（用于自动构图），失败不影响主流程
    try {
      faceDetector = await v.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: VENDOR + 'blaze_face_short_range.tflite', delegate: 'CPU' },
        runningMode: 'IMAGE',
      });
    } catch (e) {
      faceDetector = null;
    }
    emit('ready', { ok: !!segmenter, face: !!faceDetector });
    return { ok: !!segmenter, face: !!faceDetector, error: lastError };
  })();
  // 失败时不缓存坏 Promise，让用户点重试能恢复
  initPromise.catch((e) => {
    lastError = String((e && e.message) || e);
    if (!force) initPromise = null;
  });
  return initPromise;
}

/** 上一次初始化失败的原因（无失败返回 null） */
export function initError() {
  return lastError;
}

export function hasSegmenter() {
  return !!segmenter;
}

/**
 * 人像分割，返回 Float32Array(0~1) 的 alpha，尺寸与输入画布一致。
 */
export function segment(canvas) {
  if (!segmenter) throw new Error('segmenter not ready');
  const res = segmenter.segment(canvas);
  const mask = res.categoryMask;
  if (!mask) throw new Error('no mask');
  const mw = mask.width;
  const mh = mask.height;
  let src;
  if (mask.getAsFloat32Array) src = mask.getAsFloat32Array();
  else src = mask.getAsUint8Array();

  const tmp = document.createElement('canvas');
  tmp.width = mw;
  tmp.height = mh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  const id = tctx.createImageData(mw, mh);
  const d = id.data;
  for (let i = 0, n = mw * mh; i < n; i++) {
    const v = src[i];
    d[i * 4] = 255;
    d[i * 4 + 1] = 255;
    d[i * 4 + 2] = 255;
    // 实测 selfie_segmenter 输出: 类别索引 1=背景, 0=前景 → 取反后填 alpha
    d[i * 4 + 3] = v > 0.5 ? 0 : 255;
  }
  tctx.putImageData(id, 0, 0);
  mask.close();

  // 放大到原图尺寸（双线性平滑）
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  const od = octx.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, n = alpha.length; i < n; i++) alpha[i] = od[i * 4 + 3] / 255;
  return alpha;
}

/**
 * 人脸检测，返回 {x,y,w,h}（输入画布坐标系），无结果返回 null。
 */
export function detectFace(canvas) {
  if (!faceDetector) return null;
  try {
    const res = faceDetector.detect(canvas);
    const list = res.detections || [];
    if (!list.length) return null;
    let best = list[0];
    let bestArea = 0;
    for (const d of list) {
      const b = d.boundingBox;
      const a = (b.width || 0) * (b.height || 0);
      if (a > bestArea) {
        bestArea = a;
        best = d;
      }
    }
    const b = best.boundingBox;
    return { x: b.originX, y: b.originY, w: b.width, h: b.height };
  } catch (e) {
    return null;
  }
}

/**
 * 降级方案：纯色背景抠图（四边取样 + 泛洪填充）。
 * 当人像模型不可用时使用，对蓝底/白底/红底证件照原图效果良好。
 */
export function chromaKey(canvas, tolerance = 42) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // 1. 取四边中位色
  const samples = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    samples.push([d[i], d[i + 1], d[i + 2]]);
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 120));
  for (let x = 0; x < w; x += step) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    push(0, y);
    push(w - 1, y);
  }
  const mid = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bg = [mid(samples.map((s) => s[0])), mid(samples.map((s) => s[1])), mid(samples.map((s) => s[2]))];

  // 2. 泛洪：从边缘开始，颜色接近背景色的像素判为背景
  const tol2 = tolerance * tolerance;
  const visited = new Uint8Array(w * h);
  const removed = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (x, y) => {
    const p = y * w + x;
    if (!visited[p]) {
      visited[p] = 1;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (sp > 0) {
    const p = stack[--sp];
    const i = p * 4;
    const dr = d[i] - bg[0];
    const dg = d[i + 1] - bg[1];
    const db = d[i + 2] - bg[2];
    if (dr * dr + dg * dg + db * db > tol2) continue;
    removed[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  // 3. 生成 alpha（带 1px 软化）
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!removed[p]) {
        alpha[p] = 1;
        continue;
      }
      // 邻域有保留像素 -> 半透明，减轻锯齿
      let near = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!removed[ny * w + nx]) near = 1;
        }
      }
      alpha[p] = near ? 0.35 : 0;
    }
  }
  return alpha;
}

// —— alpha 后处理 ——

function boxBlur(a, w, h, r) {
  if (r <= 0) return a;
  const tmp = new Float32Array(a.length);
  const inv = 1 / (r * 2 + 1);
  // 横向
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      const s0 = Math.max(0, x - r);
      const s1 = Math.min(w - 1, x + r);
      for (let k = s0; k <= s1; k++) s += a[o + k];
      tmp[o + x] = s * (1 / (s1 - s0 + 1));
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      const s0 = Math.max(0, y - r);
      const s1 = Math.min(h - 1, y + r);
      for (let k = s0; k <= s1; k++) s += tmp[k * w + x];
      a[y * w + x] = s * (1 / (s1 - s0 + 1));
    }
  }
  void inv;
  return a;
}

function erode(a, w, h, r) {
  if (r <= 0) return a;
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = 1;
      const s0 = Math.max(0, x - r);
      const s1 = Math.min(w - 1, x + r);
      for (let k = s0; k <= s1; k++) if (a[o + k] < m) m = a[o + k];
      tmp[o + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 1;
      const s0 = Math.max(0, y - r);
      const s1 = Math.min(h - 1, y + r);
      for (let k = s0; k <= s1; k++) if (tmp[k * w + x] < m) m = tmp[k * w + x];
      a[y * w + x] = m;
    }
  }
  return a;
}

/**
 * 合成最终 alpha：基础 alpha -> 手工修补 -> 收缩去白边 -> 羽化
 */
export function refineAlpha(base, manual, w, h, feather, shrink) {
  const a = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const m = manual ? manual[i] : 0;
    let v = base[i];
    if (m > 0) v = v * (1 - m) + m;
    else if (m < 0) v = v * (1 + m);
    a[i] = v;
  }
  if (shrink > 0) erode(a, w, h, shrink);
  if (feather > 0) {
    const r = Math.max(1, Math.round(feather));
    boxBlur(a, w, h, r);
    boxBlur(a, w, h, Math.max(1, r - 1));
  }
  return a;
}

/** alpha 边界框 */
export function alphaBBox(alpha, w, h, th = 0.5) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[o + x] > th) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
