import { SPEC_GROUPS, specPx, findSpec, mmToPx, BG_PRESETS, PAPERS } from './specs.js';
import { initMatting, segment, detectFace, chromaKey, refineAlpha, alphaBBox } from './matting.js';
import { AngleController } from './angle.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const WORK_MAX = 1200;
const HEAD_TOP_RATIO = 0.075; // 头顶留白
const HEAD_H_RATIO = 0.72; // 头部（头顶至下巴）占照片高度

const S = {
  img: null,
  W: 0,
  H: 0,
  baseAlpha: null,
  manual: null,
  alpha: null,
  maskCanvas: null,
  face: null,
  bbox: null,
  specId: SPEC_GROUPS[0].items[0].id,
  custom: null,
  dpi: 300,
  bg: { name: '白底', c1: '#ffffff', c2: '#ffffff', grad: false },
  transparent: false,
  tf: { scale: 1, nx: 0.5, ny: 0.5 },
  feather: 1,
  erode: 0,
  bri: 100,
  con: 100,
  brush: 0,
  brushSize: 40,
  guides: true,
  fmt: 'png',
  paper: '6',
  cutline: true,
  fname: '证件照',
  group: 0,
  tpl: null,
  angleOn: false,
  metaOn: true,
};

const cvMain = $('#cvMain');
const cvGuide = $('#cvGuide');
const photo = $('#photo');
const canvasBox = $('#canvasBox');

/* ============ 工具 ============ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}

function curPx() {
  if (S.custom) return { w: mmToPx(S.custom.mmW, S.dpi), h: mmToPx(S.custom.mmH, S.dpi) };
  return specPx(findSpec(S.specId), S.dpi);
}

// 暴露状态与关键函数，供自动化测试 / 控制台调试使用（只读用途，不参与业务逻辑）
window.__S = S;
window.__api = { curPx, curSpecName, exportCanvas, buildMeta, paintTo, findSpec };

function curSpecName() {
  return S.custom ? `自定义 ${S.custom.mmW}×${S.custom.mmH}mm` : findSpec(S.specId).name;
}

/* ============ 图像装载 ============ */
function fitToCanvas(src, max) {
  let w = src.width;
  let h = src.height;
  const k = Math.min(1, max / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      resolve(im);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    im.src = url;
  });
}

/* ============ 抠图主流程 ============ */
async function useImage(src) {
  setStep(2);
  $('#drop').classList.add('hidden');
  $('#ws').classList.remove('hidden');
  $('#btnNew').hidden = false;
  showLoading('正在准备模型…');
  await raf();
  await sleep(30);

  const wc = fitToCanvas(src, WORK_MAX);
  S.img = wc;
  S.W = wc.width;
  S.H = wc.height;
  S.manual = new Float32Array(S.W * S.H);
  S.tf = { scale: 1, nx: 0.5, ny: 0.5 };

  try {
    await initMatting();
  } catch (e) {
    console.warn(e);
  }

  setLoading('正在识别人像…');
  await raf();
  await sleep(20);

  S.face = detectFace(wc);
  try {
    S.baseAlpha = segment(wc);
  } catch (e) {
    console.warn('AI 抠图失败，降级为纯色背景抠图', e);
    S.baseAlpha = chromaKey(wc);
    toast('AI 抠图不可用，已切换为纯色背景抠图');
  }
  S.bbox = alphaBBox(S.baseAlpha, S.W, S.H);

  setLoading('正在生成…');
  buildMask();
  hideLoading();
  autoFit();
  setStep(3);
  if (angle) angle.initHistory();
  checkBlank();
}

function showLoading(txt) {
  $('#loading').classList.remove('hidden');
  setLoading(txt);
}
function setLoading(txt) {
  $('#loadTxt').textContent = txt;
}
function hideLoading() {
  $('#loading').classList.add('hidden');
}

/* ============ 检测"上传了空白/模板图" ============ */
function avgLuminance() {
  const ctx = S.img.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, S.W, S.H).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4) / 255;
}

function checkBlank() {
  if (!S.img) return;
  const lum = avgLuminance();
  const bboxArea = S.bbox ? (S.bbox.w * S.bbox.h) / (S.W * S.H) : 0;
  if (lum > 0.92 || bboxArea < 0.015) {
    if (S.tpl) {
      toast('未检测到人物，可能是模板/空白图。点「交换」把角色对调。', 4500);
    } else {
      toast('未检测到人物，请确认上传的是正面人物照片，或把模板加载为「参考底图」。', 4500);
    }
  }
}

/* ============ 交换主照片与参考底图 ============ */
async function swapPhotoAndTemplate() {
  if (!S.tpl) {
    toast('请先加载参考底图再交换');
    return;
  }
  const oldImg = S.img;
  const oldW = S.W;
  const oldH = S.H;
  const oldAlpha = S.baseAlpha;
  const oldManual = S.manual;
  const oldFace = S.face;
  const oldBbox = S.bbox;

  showLoading('正在交换并重新抠图…');
  await raf();
  await sleep(20);

  // 原参考底图 → 新主照片
  const tplCanvas = S.tpl.canvas;
  const wc = fitToCanvas(tplCanvas, WORK_MAX);
  S.img = wc;
  S.W = wc.width;
  S.H = wc.height;
  S.manual = new Float32Array(S.W * S.H);

  // 原主照片 → 新参考底图
  S.tpl = {
    canvas: oldImg,
    w: oldW,
    h: oldH,
    opacity: 0.45,
    visible: true,
  };
  $('#tplOp').value = '0.45';
  $('#vTpl').textContent = '0.45';
  $('#tplOn').checked = true;

  S.tf = { scale: 1, nx: 0.5, ny: 0.5 };
  S.face = detectFace(wc);
  try {
    S.baseAlpha = segment(wc);
  } catch (e) {
    S.baseAlpha = chromaKey(wc);
    toast('AI 抠图不可用，已切换为纯色背景抠图');
  }
  S.bbox = alphaBBox(S.baseAlpha, S.W, S.H);
  buildMask();
  hideLoading();
  autoFit();
  toast('已交换：原主图 → 参考底图；原模板 → 主照片');
  void oldAlpha;
  void oldManual;
  void oldFace;
  void oldBbox;
}

/* ============ 遮罩合成 ============ */
function buildMask() {
  if (!S.img) return;
  S.alpha = refineAlpha(S.baseAlpha, S.manual, S.W, S.H, S.feather, S.erode);
  if (!S.maskCanvas) S.maskCanvas = document.createElement('canvas');
  S.maskCanvas.width = S.W;
  S.maskCanvas.height = S.H;
  const ctx = S.maskCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, S.W, S.H);
  ctx.drawImage(S.img, 0, 0);
  const id = ctx.getImageData(0, 0, S.W, S.H);
  const d = id.data;
  const a = S.alpha;
  for (let i = 0, p = 0; i < a.length; i++, p += 4) d[p + 3] = a[i] * 255;
  ctx.putImageData(id, 0, 0);
}

/* ============ 渲染 ============ */
let angle = null; // AngleController，在启动时初始化
function tfRect(p) {
  const k = Math.max(p.w / S.W, p.h / S.H);
  const sc = k * S.tf.scale;
  return { sc, dw: S.W * sc, dh: S.H * sc, dx: S.tf.nx * p.w - (S.W * sc) / 2, dy: S.tf.ny * p.h - (S.H * sc) / 2 };
}

function paintTo(ctx, w, h, opt = {}) {
  const bg = opt.bg || S.bg;
  const transparent = opt.transparent !== undefined ? opt.transparent : S.transparent;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  if (!transparent) {
    if (bg.grad) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, bg.c1);
      g.addColorStop(1, bg.c2);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = bg.c1;
    }
    ctx.fillRect(0, 0, w, h);
  }
  if (S.maskCanvas) {
    const t = tfRect({ w, h });
    if (S.bri !== 100 || S.con !== 100) ctx.filter = `brightness(${S.bri}%) contrast(${S.con}%)`;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const handled = angle && angle.isEnabled() && angle.renderForeground(ctx, w, h);
    if (!handled) ctx.drawImage(S.maskCanvas, t.dx, t.dy, t.dw, t.dh);
  }
  ctx.restore();
}

function render() {
  if (!S.img) return;
  const p = curPx();
  cvMain.width = p.w;
  cvMain.height = p.h;
  paintTo(cvMain.getContext('2d', { willReadFrequently: true }), p.w, p.h);
  fitPhoto();
  drawGuides(p);
  renderStrip();
  updateHints();
}

function fitPhoto() {
  const p = curPx();
  const availW = canvasBox.clientWidth - 32;
  const availH = canvasBox.clientHeight - 32;
  if (availW <= 0 || availH <= 0) return;
  const r = p.w / p.h;
  let h = availH;
  let w = h * r;
  if (w > availW) {
    w = availW;
    h = w / r;
  }
  photo.style.width = Math.max(40, w) + 'px';
  photo.style.height = Math.max(40, h) + 'px';
}

function drawGuides(p) {
  cvGuide.width = p.w;
  cvGuide.height = p.h;
  const ctx = cvGuide.getContext('2d');
  ctx.clearRect(0, 0, p.w, p.h);
  drawTemplate(p);
  if (S.guides) {
    const lw = Math.max(1, p.w / 380);
    ctx.lineWidth = lw;
    ctx.setLineDash([p.w * 0.025, p.w * 0.018]);
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    const hline = (y) => {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(p.w, y);
      ctx.stroke();
    };
    hline(p.h * HEAD_TOP_RATIO);
    hline(p.h * (HEAD_TOP_RATIO + HEAD_H_RATIO));
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath();
    ctx.moveTo(p.w / 2, 0);
    ctx.lineTo(p.w / 2, p.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.strokeRect(p.w * 0.05, p.h * 0.02, p.w * 0.9, p.h * 0.96);
    const fs = Math.max(7, Math.round(p.w * 0.045));
    ctx.font = `${fs}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText('头顶', p.w * 0.03, p.h * HEAD_TOP_RATIO - p.h * 0.012);
    ctx.fillText('下巴', p.w * 0.03, p.h * (HEAD_TOP_RATIO + HEAD_H_RATIO) - p.h * 0.012);
  }
  // 角度叠层（网格 + 旋转中心标记）必须**无条件**绘制：
  // 早期版本写成「if (!S.guides) { drawAngleOverlay(); return; }」，
  // 导致构图辅助线一开启，角度网格与轴心标记就整个消失。
  drawAngleOverlay(p);
}

/* 三分构图网格 + 旋转手柄 */
function drawAngleOverlay(p) {
  if (!angle || !angle.isEnabled()) return;
  const ctx = cvGuide.getContext('2d');
  if (angle.grid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,190,255,.55)';
    ctx.lineWidth = Math.max(1, p.w / 600);
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo((p.w * i) / 3, 0);
      ctx.lineTo((p.w * i) / 3, p.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (p.h * i) / 3);
      ctx.lineTo(p.w, (p.h * i) / 3);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 旋转中心标记
  if (angle.pivot !== 'center') {
    const c = pivotPoint(p);
    // 标记尺寸要够醒目：早期版本按 p.w * 0.03 取半径，
    // 在小尺寸画布（如 295px 宽的一寸照）上只有 9px，实际几乎看不见。
    const R = Math.max(10, p.w * 0.075);
    const arm = R * 1.55;
    const lw = Math.max(2, p.w / 160);
    ctx.save();
    // 外圈加一层深色描边，保证在浅色背景上也能看清
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = lw + 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.x - arm, c.y);
    ctx.lineTo(c.x + arm, c.y);
    ctx.moveTo(c.x, c.y - arm);
    ctx.lineTo(c.x, c.y + arm);
    ctx.stroke();
    // 亮色主体
    ctx.strokeStyle = 'rgba(255,190,60,.95)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.x - arm, c.y);
    ctx.lineTo(c.x + arm, c.y);
    ctx.moveTo(c.x, c.y - arm);
    ctx.lineTo(c.x, c.y + arm);
    ctx.stroke();
    // 中心点
    ctx.fillStyle = 'rgba(255,190,60,.95)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(2, R * 0.18), 0, Math.PI * 2);
    ctx.fill();
    // 提示文字（仅在画布够大时显示，避免小图上糊成一片）
    if (p.w >= 220) {
      const fs = Math.max(9, Math.round(p.w * 0.042));
      ctx.font = `600 ${fs}px sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillText('旋转中心', c.x + arm + 3, c.y + fs * 0.35 + 1);
      ctx.fillStyle = 'rgba(255,190,60,.95)';
      ctx.fillText('旋转中心', c.x + arm + 2, c.y + fs * 0.35);
    }
    ctx.restore();
  }
}

function pivotPoint(p) {
  if (angle) return angle.pivotPixel(p.w, p.h);
  return { x: p.w / 2, y: p.h / 2 };
}

/* ============ 参考底图（定位模板） ============ */
async function loadTemplate(file) {
  if (!file) return;
  const im = await loadImageFromFile(file);
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(im, 0, 0);
  S.tpl = { canvas: c, w: im.width, h: im.height, opacity: 0.45, visible: true };
  $('#tplOp').value = '0.45';
  $('#vTpl').textContent = '0.45';
  $('#tplOn').checked = true;
  render();
  toast('参考底图已加载（仅用于定位，不会导出）');
}

function clearTemplate() {
  S.tpl = null;
  render();
  toast('已清除参考底图');
}

function drawTemplate(p) {
  if (!S.tpl || !S.tpl.visible) return;
  const t = S.tpl;
  const ctx = cvGuide.getContext('2d');
  ctx.save();
  ctx.globalAlpha = t.opacity;
  ctx.drawImage(t.canvas, 0, 0, p.w, p.h);
  ctx.restore();
}


/* ============ 自动构图 ============ */
function autoFit() {
  if (!S.img) return;
  const p = curPx();
  let headTop = 0;
  let headH = 0;
  let cx = S.W / 2;
  if (S.face) {
    const f = S.face;
    headTop = f.y - f.h * 0.3;
    headH = f.h * 1.34;
    cx = f.x + f.w / 2;
  } else if (S.bbox) {
    headTop = S.bbox.y;
    headH = S.bbox.h * 0.62;
    cx = S.bbox.x + S.bbox.w / 2;
  } else {
    return;
  }
  const total = (p.h * HEAD_H_RATIO) / headH;
  const k = Math.max(p.w / S.W, p.h / S.H);
  S.tf.scale = clamp(total / k, 0.3, 3);
  const sc = k * S.tf.scale;
  const dw = S.W * sc;
  const dh = S.H * sc;
  const yTop = p.h * HEAD_TOP_RATIO - headTop * total;
  S.tf.ny = (yTop + dh / 2) / p.h;
  S.tf.nx = (p.w * 0.5 + dw / 2 - cx * total) / p.w;
  clampTf();
  syncZoom();
  render();
}

function clampTf() {
  S.tf.scale = clamp(S.tf.scale, 0.3, 3);
  S.tf.nx = clamp(S.tf.nx, -0.6, 1.6);
  S.tf.ny = clamp(S.tf.ny, -0.6, 1.6);
}

function syncZoom() {
  $('#zoom').value = S.tf.scale;
}

/* ============ 交互：平移 / 缩放 / 涂抹 ============ */
const pointers = new Map();
let mode = null; // 'pan' | 'brush' | 'pinch'
let last = null;
let pinch = null;
let paintDirty = false;

function toLocal(e, p) {
  const r = photo.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * p.w;
  const py = ((e.clientY - r.top) / r.height) * p.h;
  const t = tfRect(p);
  return { px, py, sx: (px - t.dx) / t.sc, sy: (py - t.dy) / t.sc };
}

function paintBrush(sx, sy, sign) {
  if (!S.manual) return;
  const r = S.brushSize / 2;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(sx - r));
  const x1 = Math.min(S.W - 1, Math.ceil(sx + r));
  const y0 = Math.max(0, Math.floor(sy - r));
  const y1 = Math.min(S.H - 1, Math.ceil(sy + r));
  const m = S.manual;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - sx;
      const dy = y - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const f = 1 - Math.sqrt(d2) / r;
      const i = y * S.W + x;
      const nv = m[i] + (sign - m[i]) * Math.min(1, f * 0.85 + 0.15);
      m[i] = clamp(nv, -1, 1);
    }
  }
  paintDirty = true;
}

function strokeBrush(a, b, sign) {
  const dist = Math.hypot(b.sx - a.sx, b.sy - a.sy);
  const steps = Math.max(1, Math.ceil(dist / (S.brushSize / 4)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    paintBrush(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t, sign);
  }
}

function scheduleRebuild() {
  if (!paintDirty) return;
  paintDirty = false;
  buildMask();
  render();
}

photo.addEventListener('pointerdown', (e) => {
  if (!S.img) return;
  photo.setPointerCapture(e.pointerId);
  const p = curPx();
  pointers.set(e.pointerId, toLocal(e, p));
  if (pointers.size === 2) {
    const [a, b] = Array.from(pointers.values());
    pinch = { d: Math.hypot(a.px - b.px, a.py - b.py), scale: S.tf.scale };
    mode = 'pinch';
    return;
  }
  if (S.brush !== 0) {
    mode = 'brush';
    last = pointers.get(e.pointerId);
    paintBrush(last.sx, last.sy, S.brush);
    scheduleRebuild();
  } else if (angle && angle.isEnabled()) {
    mode = 'angle';
    last = { px: e.clientX, py: e.clientY };
    const lp = pointers.get(e.pointerId);
    // 只有在「自定义轴心」且用户按在轴心标记附近时才移动轴心；
    // 否则普通拖拽一律视为旋转，不因一次旋转就悄悄改掉轴心位置。
    angle.movingPivot = angle.pivot === 'custom' && angle.hitPivot(lp.px, lp.py, p.w);
  } else {
    mode = 'pan';
    last = { px: e.clientX, py: e.clientY };
  }
});

photo.addEventListener('pointermove', (e) => {
  if (!S.img) return;
  if (!pointers.has(e.pointerId)) return;
  const p = curPx();
  const cur = toLocal(e, p);
  pointers.set(e.pointerId, cur);

  if (mode === 'pinch' && pointers.size >= 2 && pinch) {
    const [a, b] = Array.from(pointers.values());
    const d = Math.hypot(a.px - b.px, a.py - b.py);
    if (pinch.d > 0) S.tf.scale = clamp(pinch.scale * (d / pinch.d), 0.3, 3);
    clampTf();
    syncZoom();
    render();
    return;
  }
  if (mode === 'brush') {
    strokeBrush(last, cur, S.brush);
    last = cur;
    scheduleRebuild();
    return;
  }
  if (mode === 'angle') {
    const r = photo.getBoundingClientRect();
    const dx = (e.clientX - last.px) / r.width;
    const dy = (e.clientY - last.py) / r.height;
    last = { px: e.clientX, py: e.clientY };
    angle.drag(dx, dy, { px: cur.px, py: cur.py, ow: p.w, oh: p.h });
    return;
  }
  if (mode === 'pan') {
    const r = photo.getBoundingClientRect();
    const dxPhoto = ((e.clientX - last.px) / r.width) * p.w;
    const dyPhoto = ((e.clientY - last.py) / r.height) * p.h;
    S.tf.nx += dxPhoto / p.w;
    S.tf.ny += dyPhoto / p.h;
    last = { px: e.clientX, py: e.clientY };
    clampTf();
    render();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    if (mode === 'angle' && angle) angle.endDrag();
    mode = null;
    last = null;
    if (paintDirty) {
      buildMask();
      render();
      paintDirty = false;
    }
  }
}
photo.addEventListener('pointerup', endPointer);
photo.addEventListener('pointercancel', endPointer);

photo.addEventListener(
  'wheel',
  (e) => {
    if (!S.img) return;
    e.preventDefault();
    const p = curPx();
    const before = toLocal(e, p);
    const f = Math.exp(-e.deltaY * 0.0016);
    S.tf.scale = clamp(S.tf.scale * f, 0.3, 3);
    const t = tfRect(p);
    S.tf.nx = (before.px + t.dw / 2 - before.sx * t.sc) / p.w;
    S.tf.ny = (before.py + t.dh / 2 - before.sy * t.sc) / p.h;
    clampTf();
    syncZoom();
    render();
  },
  { passive: false }
);

/* ============ 导出 ============ */
function exportCanvas(bgOverride) {
  const p = curPx();
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  paintTo(ctx, p.w, p.h, bgOverride ? { bg: bgOverride } : {});
  // 镜头畸变后处理（仅在前景变换启用时生效）
  if (angle && angle.isEnabled() && !angle.isNeutral() && angle.params.distort) {
    angle.applyDistort(ctx, p.w, p.h);
  }
  return c;
}

function download(canvas, name, fmt) {
  const isJpg = fmt === 'jpg';
  const type = isJpg ? 'image/jpeg' : 'image/png';
  canvas.toBlob(
    (blob) => {
      const finish = (b) => {
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url;
        a.download = name + (isJpg ? '.jpg' : '.png');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      };
      if (!isJpg && S.metaOn) {
        embedMeta(blob, buildMeta()).then(finish).catch(() => finish(blob));
      } else {
        finish(blob);
      }
    },
    type,
    0.95
  );
}

/* ---------- PNG 参数元数据（tEXt 块） ---------- */

/** 汇总当前制作参数，供写入 PNG / 导出 JSON */
function buildMeta() {
  const p = curPx();
  const meta = {
    app: 'id-photo-studio',
    kind: 'id-photo-meta',
    version: 1,
    savedAt: new Date().toISOString(),
    spec: { id: S.custom ? 'custom' : S.specId, name: curSpecName(), mmW: S.custom ? S.custom.mmW : findSpec(S.specId).mmW, mmH: S.custom ? S.custom.mmH : findSpec(S.specId).mmH, dpi: S.dpi },
    output: { w: p.w, h: p.h },
    background: S.transparent ? { transparent: true } : { c1: S.bg.c1, c2: S.bg.c2, grad: !!S.bg.grad },
    tone: { brightness: S.bri, contrast: S.con },
    transform: { nx: S.tf.nx, ny: S.tf.ny, scale: S.tf.scale },
    angle: angle ? { enabled: !!angle.isEnabled(), params: angle.getParams(), pivot: angle.pivot } : null,
  };
  return meta;
}

function crc32(u8) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = data.length;
  const buf = new Uint8Array(12 + len);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  const crcInput = buf.subarray(4, 8 + len);
  dv.setUint32(8 + len, crc32(crcInput));
  return buf;
}

/** 把 JSON 元数据作为 tEXt 块插入 PNG，返回新的 Blob */
async function embedMeta(blob, meta) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not png');
  // 在 IHDR 之后插入 tEXt
  let off = 8;
  const chunks = [];
  while (off < buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off);
    const len = dv.getUint32(0);
    const total = 12 + len;
    chunks.push(buf.subarray(off, off + total));
    off += total;
    const t = String.fromCharCode(buf[off - total + 4], buf[off - total + 5], buf[off - total + 6], buf[off - total + 7]);
    if (t === 'IHDR') break;
  }
  const keyword = 'Software';
  const json = JSON.stringify(meta);
  const text = keyword + '\0' + 'IDPhotoStudio\0' + json;
  const enc = new TextEncoder().encode(text);
  const head = new Uint8Array(8).map((_, i) => sig[i]);
  const parts = [head, ...chunks, pngChunk('tEXt', enc), buf.subarray(off)];
  return new Blob(parts, { type: 'image/png' });
}

function buildSheet() {
  const p = curPx();
  const L = sheetLayout(p);
  const { PW, PH, m, g, cols, rows, cw, ch } = L;

  const c = document.createElement('canvas');
  c.width = PW;
  c.height = PH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PW, PH);

  const one = exportCanvas({ name: 'sheet', c1: S.transparent ? '#ffffff' : S.bg.c1, c2: S.transparent ? '#ffffff' : S.bg.c2, grad: S.transparent ? false : S.bg.grad });
  const usedW = cols * cw + (cols - 1) * g;
  const usedH = rows * ch + (rows - 1) * g;
  const ox = (PW - usedW) / 2;
  const oy = (PH - usedH) / 2;
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      const x = ox + cc * (cw + g);
      const y = oy + r * (ch + g);
      ctx.drawImage(one, x, y, cw, ch);
      if (S.cutline) {
        ctx.save();
        ctx.strokeStyle = '#b9bcc2';
        ctx.lineWidth = Math.max(1, PW / 1200);
        ctx.setLineDash([PW * 0.006, PW * 0.005]);
        ctx.strokeRect(x - g / 2, y - g / 2, cw + g, ch + g);
        ctx.restore();
      }
    }
  }
  return { canvas: c, total: L.total, cols, rows, PW, PH };
}

/* ============ UI：规格 ============ */
function renderSpecGroups() {
  $('#specGroup').innerHTML = SPEC_GROUPS.map((g, i) => `<button data-g="${i}" class="${i === S.group ? 'on' : ''}">${g.group}</button>`).join('');
}

function renderSpecList() {
  const items = SPEC_GROUPS[S.group].items;
  $('#specList').innerHTML = items
    .map((s) => {
      const px = specPx(s, S.dpi);
      const on = !S.custom && s.id === S.specId;
      return `<div class="spec ${on ? 'on' : ''}" data-id="${s.id}">
        <b>${s.name}</b><small>${s.mmW}×${s.mmH}mm</small><em>${px.w}×${px.h}px</em></div>`;
    })
    .join('');
}

function updateHints() {
  const p = curPx();
  const spec = S.custom ? { note: '自定义尺寸' } : findSpec(S.specId);
  $('#specHint').textContent = `${curSpecName()} ｜ ${p.w}×${p.h}px @${S.dpi}dpi${spec.note ? ' ｜ ' + spec.note : ''}`;
  const sheet = calcSheetInfo();
  $('#sheetHint').textContent = sheet
    ? `${PAPERS[S.paper].name} ${sheet.PW}×${sheet.PH}px，可排 ${sheet.total} 张（${sheet.cols}×${sheet.rows}）`
    : '';
}

function sheetLayout(p) {
  const paper = PAPERS[S.paper];
  const PW = mmToPx(paper.mmW, S.dpi);
  const PH = mmToPx(paper.mmH, S.dpi);
  const m = mmToPx(2, S.dpi);
  const g = mmToPx(2, S.dpi);
  let cw = p.w;
  let ch = p.h;
  const fit = Math.min((PW - 2 * m) / p.w, (PH - 2 * m) / p.h);
  if (fit < 1) {
    cw = Math.max(1, Math.floor(p.w * fit));
    ch = Math.max(1, Math.floor(p.h * fit));
  }
  const cols = Math.max(1, Math.floor((PW - 2 * m + g) / (cw + g)));
  const rows = Math.max(1, Math.floor((PH - 2 * m + g) / (ch + g)));
  return { PW, PH, m, g, cols, rows, cw, ch, total: cols * rows };
}

function calcSheetInfo() {
  if (!S.img) return null;
  return sheetLayout(curPx());
}

/* ============ UI：底色 ============ */
function renderBg() {
  $('#bgChips').innerHTML = BG_PRESETS.filter((b) => b.common)
    .map((b, i) => {
      const on = !S.transparent && S.bg.name === b.name;
      const style = b.grad ? `linear-gradient(180deg,${b.c1},${b.c2})` : b.c1;
      return `<button class="chip ${on ? 'on' : ''}" data-i="${i}"><span class="sw" style="background:${style}"></span>${b.name}</button>`;
    })
    .join('');

  $('#bgList').innerHTML = BG_PRESETS.map((b, i) => {
    const on = !S.transparent && S.bg.name === b.name;
    const style = b.grad ? `linear-gradient(180deg,${b.c1},${b.c2})` : b.c1;
    return `<div class="sw ${on ? 'on' : ''}" data-i="${i}"><i style="background:${style}"></i><span>${b.name}</span></div>`;
  }).join('');
}

function renderStrip() {
  const box = $('#strip');
  const list = [
    { name: '白底', c1: '#ffffff', c2: '#ffffff', grad: false },
    { name: '蓝底', c1: '#438edb', c2: '#438edb', grad: false },
    { name: '红底', c1: '#e02b2b', c2: '#e02b2b', grad: false },
  ];
  if (!box.dataset.init) {
    box.innerHTML = list
      .map(
        (b, i) => `<div class="it" data-i="${i}"><canvas></canvas><span>${b.name}</span></div>`
      )
      .join('');
    box.dataset.init = '1';
  }
  const p = curPx();
  Array.from(box.querySelectorAll('canvas')).forEach((c, i) => {
    const scale = Math.min(1, 140 / p.w);
    c.width = Math.round(p.w * scale);
    c.height = Math.round(p.h * scale);
    paintTo(c.getContext('2d'), c.width, c.height, { bg: list[i], transparent: false });
  });
}

function setBg(b) {
  S.bg = { ...b };
  S.transparent = false;
  $('#transparent').checked = false;
  $('#c1').value = b.c1;
  $('#c2').value = b.c2;
  $('#grad').checked = !!b.grad;
  renderBg();
  render();
  setStep(4);
}

/* ============ 步骤 ============ */
function setStep(n) {
  $$('#steps span').forEach((el) => {
    const s = +el.dataset.s;
    el.classList.toggle('on', s === n);
    el.classList.toggle('done', s < n);
  });
}

/* ============ 事件绑定 ============ */
function bind() {
  // 上传
  $('#btnPick').onclick = () => $('#file').click();
  $('#file').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const im = await loadImageFromFile(f);
      await useImage(im);
    } catch (err) {
      toast(err.message || '图片读取失败');
    }
    e.target.value = '';
  };

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) {
      const im = await loadImageFromFile(f);
      await useImage(im);
    }
  });
  window.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const im = await loadImageFromFile(it.getAsFile());
        await useImage(im);
        break;
      }
    }
  });

  // 重做
  $('#btnNew').onclick = () => {
    S.img = null;
    S.baseAlpha = null;
    S.manual = null;
    S.maskCanvas = null;
    S.custom = null;
    $('#ws').classList.add('hidden');
    $('#drop').classList.remove('hidden');
    $('#btnNew').hidden = true;
    setStep(1);
  };

  // 面板切换
  $$('.tab').forEach((t) => {
    t.onclick = () => {
      $$('.tab').forEach((x) => x.classList.remove('on'));
      $$('.pane').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      $(`.pane[data-pane="${t.dataset.tab}"]`).classList.add('on');
      if (t.dataset.tab === 'bg') renderStrip();
      if (t.dataset.tab === 'out') updateHints();
    };
  });

  // 规格
  $('#specGroup').onclick = (e) => {
    const b = e.target.closest('button[data-g]');
    if (!b) return;
    S.group = +b.dataset.g;
    renderSpecGroups();
    renderSpecList();
  };
  $('#specList').onclick = (e) => {
    const el = e.target.closest('.spec');
    if (!el) return;
    S.specId = el.dataset.id;
    S.custom = null;
    renderSpecList();
    const s = findSpec(S.specId);
    $('#mmW').value = s.mmW;
    $('#mmH').value = s.mmH;
    render();
    setStep(3);
  };
  const onMM = () => {
    const w = parseFloat($('#mmW').value);
    const h = parseFloat($('#mmH').value);
    if (w > 5 && h > 5) {
      S.custom = { mmW: w, mmH: h };
      renderSpecList();
      render();
    }
  };
  $('#mmW').oninput = onMM;
  $('#mmH').oninput = onMM;
  $('#dpi').onchange = (e) => {
    S.dpi = +e.target.value;
    renderSpecList();
    render();
  };

  // 底色
  $('#bgChips').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const list = BG_PRESETS.filter((x) => x.common);
    setBg(list[+b.dataset.i]);
  };
  $('#bgList').onclick = (e) => {
    const el = e.target.closest('.sw');
    if (!el) return;
    setBg(BG_PRESETS[+el.dataset.i]);
  };
  $('#strip').onclick = (e) => {
    const el = e.target.closest('.it');
    if (!el) return;
    const list = [
      { name: '白底', c1: '#ffffff', c2: '#ffffff', grad: false },
      { name: '蓝底', c1: '#438edb', c2: '#438edb', grad: false },
      { name: '红底', c1: '#e02b2b', c2: '#e02b2b', grad: false },
    ];
    setBg(list[+el.dataset.i]);
  };
  $('#c1').oninput = (e) => {
    S.bg.c1 = e.target.value;
    S.bg.name = '自定义';
    S.bg.grad = $('#grad').checked;
    S.transparent = false;
    $('#transparent').checked = false;
    renderBg();
    render();
  };
  $('#c2').oninput = (e) => {
    S.bg.c2 = e.target.value;
    S.bg.grad = true;
    $('#grad').checked = true;
    renderBg();
    render();
  };
  $('#grad').onchange = (e) => {
    S.bg.grad = e.target.checked;
    render();
  };
  $('#transparent').onchange = (e) => {
    S.transparent = e.target.checked;
    renderBg();
    render();
  };

  // 精修
  const debouncedBuild = debounce(() => {
    buildMask();
    render();
  }, 60);
  $('#feather').oninput = (e) => {
    S.feather = +e.target.value;
    $('#vFeather').textContent = S.feather.toFixed(1);
    debouncedBuild();
  };
  $('#erode').oninput = (e) => {
    S.erode = +e.target.value;
    $('#vErode').textContent = S.erode;
    debouncedBuild();
  };
  $('#bri').oninput = (e) => {
    S.bri = +e.target.value;
    $('#vBri').textContent = S.bri;
    render();
  };
  $('#con').oninput = (e) => {
    S.con = +e.target.value;
    $('#vCon').textContent = S.con;
    render();
  };
  $('#brush').oninput = (e) => {
    S.brushSize = +e.target.value;
    $('#vBrush').textContent = S.brushSize;
  };
  $('#brushMode').onclick = (e) => {
    const b = e.target.closest('button[data-b]');
    if (!b) return;
    S.brush = +b.dataset.b;
    $$('#brushMode button').forEach((x) => x.classList.toggle('on', x === b));
    photo.classList.toggle('brush', S.brush !== 0);
  };
  $('#btnClearBrush').onclick = () => {
    if (!S.manual) return;
    S.manual.fill(0);
    buildMask();
    render();
    toast('已清除修补痕迹');
  };

  // 参考底图
  $('#btnTpl').onclick = () => $('#fileTpl').click();
  $('#btnTpl2').onclick = () => $('#fileTpl').click();
  $('#fileTpl').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      await loadTemplate(f);
    } catch (err) {
      toast(err.message || '参考图读取失败');
    }
    e.target.value = '';
  };
  $('#btnTplClear').onclick = clearTemplate;
  $('#tplOn').onchange = (e) => {
    if (!S.tpl) return;
    S.tpl.visible = e.target.checked;
    render();
  };
  $('#tplOp').oninput = (e) => {
    if (!S.tpl) return;
    S.tpl.opacity = +e.target.value;
    $('#vTpl').textContent = (+e.target.value).toFixed(2);
    render();
  };
  $('#btnSwap').onclick = () => swapPhotoAndTemplate();

  // 画面操作
  $('#btnGuide').onclick = (e) => {
    S.guides = !S.guides;
    e.currentTarget.classList.toggle('primary', S.guides);
    render();
  };
  $('#zoom').oninput = (e) => {
    S.tf.scale = clamp(+e.target.value, 0.3, 3);
    render();
  };
  $('#zoomIn').onclick = () => {
    S.tf.scale = clamp(S.tf.scale * 1.1, 0.3, 3);
    syncZoom();
    render();
  };
  $('#zoomOut').onclick = () => {
    S.tf.scale = clamp(S.tf.scale / 1.1, 0.3, 3);
    syncZoom();
    render();
  };
  $('#btnAuto').onclick = () => {
    autoFit();
    toast('已按证件照标准自动构图');
  };
  $('#btnReset').onclick = () => {
    S.tf = { scale: 1, nx: 0.5, ny: 0.5 };
    syncZoom();
    render();
  };

  // 角度模式开关
  $('#btnAngle').onclick = (e) => {
    if (!angle) return;
    angle.enabled = !angle.enabled;
    e.currentTarget.classList.toggle('primary', angle.enabled);
    e.currentTarget.textContent = angle.enabled ? '角度 ✓' : '角度';
    // 切到角度面板
    if (angle.enabled) {
      $$('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'angle'));
      $$('.pane').forEach((x) => x.classList.toggle('on', x.dataset.pane === 'angle'));
    }
    render();
    toast(angle.enabled ? '已开启角度模式：直接拖动画布即可旋转' : '已关闭角度模式');
  };

  // 导出
  $('#fname').oninput = (e) => {
    S.fname = e.target.value.trim() || '证件照';
  };
  $('#fmt').onclick = (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    S.fmt = b.dataset.f;
    $$('#fmt button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#metaOn').onchange = (e) => {
    S.metaOn = e.target.checked;
  };
  $('#paper').onclick = (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    S.paper = b.dataset.p;
    $$('#paper button').forEach((x) => x.classList.toggle('on', x === b));
    updateHints();
  };
  $('#cutline').onchange = (e) => {
    S.cutline = e.target.checked;
  };
  $('#btnDownload').onclick = () => {
    if (!S.img) return;
    const c = exportCanvas();
    if (S.transparent && S.fmt === 'jpg') toast('透明背景已按白色导出 JPG');
    download(c, `${S.fname}_${curSpecName()}_${curPx().w}x${curPx().h}`, S.fmt);
    setStep(5);
    toast('已开始下载');
  };
  $('#btnSheet').onclick = () => {
    if (!S.img) return;
    const r = buildSheet();
    download(r.canvas, `${S.fname}_${PAPERS[S.paper].name}_${r.total}张`, 'jpg');
    setStep(5);
    toast(`排版完成：${r.total} 张（${r.cols}×${r.rows}）`);
  };
  $('#btnBatch').onclick = async () => {
    if (!S.img) return;
    const list = [
      { name: '白底', c1: '#ffffff', c2: '#ffffff', grad: false },
      { name: '蓝底', c1: '#438edb', c2: '#438edb', grad: false },
      { name: '红底', c1: '#e02b2b', c2: '#e02b2b', grad: false },
    ];
    for (const b of list) {
      const c = exportCanvas(b);
      download(c, `${S.fname}_${curSpecName()}_${b.name}`, S.fmt);
      await sleep(400);
    }
    toast('三张底色已全部下载');
  };

  // 拍照
  $('#btnCam').onclick = openCam;
  $('#camClose').onclick = closeCam;
  $('#camShot').onclick = shot;
  $('#camSwitch').onclick = () => {
    camFacing = camFacing === 'user' ? 'environment' : 'user';
    closeCam();
    openCam();
  };

  window.addEventListener('resize', () => {
    fitPhoto();
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* ============ 摄像头 ============ */
let camStream = null;
let camFacing = 'user';
async function openCam() {
  $('#camModal').classList.remove('hidden');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camFacing, width: { ideal: 1280 } },
      audio: false,
    });
    $('#camVideo').srcObject = camStream;
  } catch (e) {
    toast('无法访问摄像头，请检查权限或改用 HTTPS / localhost 访问');
    closeCam();
  }
}
function closeCam() {
  $('#camModal').classList.add('hidden');
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
}
async function shot() {
  const v = $('#camVideo');
  if (!v.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  if (camFacing === 'user') {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(v, 0, 0);
  closeCam();
  await useImage(c);
}

/* ============ 启动 ============ */
angle = new AngleController({
  getState: () => S,
  getOutputSize: () => curPx(),
  onChange: () => {
    // 角度变化只需要重绘主画布，无需重建遮罩
    if (S.img) {
      const p = curPx();
      cvMain.width = p.w;
      cvMain.height = p.h;
      paintTo(cvMain.getContext('2d', { willReadFrequently: true }), p.w, p.h);
      drawGuides(p);
    }
  },
  toast,
});
// 角度模式默认关闭，保持原有平移/缩放手感
angle.enabled = false;

renderSpecGroups();
renderSpecList();
renderBg();
bind();
setStep(1);
$('#mmW').value = findSpec(S.specId).mmW;
$('#mmH').value = findSpec(S.specId).mmH;
$('#btnGuide').classList.add('primary');
renderStrip();
updateHints();

// 预加载模型，缩短首次抠图等待
if (window.requestIdleCallback) window.requestIdleCallback(() => initMatting().catch(() => {}));
else setTimeout(() => initMatting().catch(() => {}), 800);
