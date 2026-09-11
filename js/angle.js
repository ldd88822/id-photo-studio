// 角度控制器：滑块 + 数值输入 + 画布拖拽旋转 + 撤销重做
// 与 app.js 的耦合点通过 deps 注入，避免循环依赖。

import {
  ANGLE_PARAMS,
  defaultParams,
  isNeutral,
  buildMatrix,
  renderTransformed,
} from './transform.js';
import { History } from './history.js';

const $ = (s, r = document) => r.querySelector(s);

const GROUPS = {
  rotate: ['rotate'],
  pitch: ['pitch'],
};

export class AngleController {
  /**
   * @param {object} deps
   * @param {()=>object} deps.getState 读取共享状态（含 W/H/maskCanvas/face）
   * @param {()=>{w:number,h:number}} deps.getOutputSize 输出画布尺寸
   * @param {()=>void} deps.onChange 参数变化后请求重绘
   * @param {(msg:string)=>void} deps.toast
   * @param {()=>void} deps.commitSnap 参数提交后需要同步到外部历史时调用
   */
  constructor(deps) {
    this.deps = deps;
    this.params = defaultParams();
    this.mode = 'rotate';
    this.pivot = 'center';
    this.pivotXY = { x: 0.5, y: 0.5 }; // 归一化
    this.grid = false;
    this.snapLevel = true;
    this.enabled = false;
    this.movingPivot = false; // 本次拖拽是否在移动旋转中心
    this.history = new History({ limit: 80, mergeMs: 500 });
    this._lastCommit = 0;
    this._buildUI();
    this.history.on((st) => this._syncHistoryUI(st));
    this._syncHistoryUI(this.history.status());
  }

  /* ---------- 参数读写 ---------- */

  getParams() {
    return { ...this.params };
  }

  setParams(p, { silent = false } = {}) {
    this.params = { ...defaultParams(), ...p };
    this._syncSliders();
    if (!silent) this.deps.onChange();
  }

  getMode() {
    return this.mode;
  }

  isEnabled() {
    return this.enabled;
  }

  /* ---------- 矩阵与渲染 ---------- */

  /** 当前是否处于「无角度变换」状态 */
  isNeutral() {
    return isNeutral(this.params);
  }

  /**
   * 输出像素 → 源图像素 的矩阵。
   * 旋转中心（pivot）在此解算；view 承接主应用的构图状态（scale/nx/ny），
   * 保证开启角度模式时不会丢掉「自动构图 + 用户平移缩放」的结果。
   */
  matrix() {
    const st = this.deps.getState();
    const out = this.deps.getOutputSize();
    const pv = this.pivotPixel(out.w, out.h);
    return buildMatrix(this.params, out.w, out.h, st.W, st.H, pv, st.tf);
  }

  /** 旋转中心在当前输出画布上的像素坐标；默认返回画布中心 */
  pivotPixel(ow, oh) {
    if (this.pivot === 'face' && this.deps.getState().face) {
      const st = this.deps.getState();
      const f = st.face;
      return { x: ((f.x + f.w / 2) / st.W) * ow, y: ((f.y + f.h / 2) / st.H) * oh };
    }
    if (this.pivot === 'custom') {
      return { x: this.pivotXY.x * ow, y: this.pivotXY.y * oh };
    }
    return { x: ow / 2, y: oh / 2 };
  }

  /**
   * 判断某个局部坐标是否命中了旋转中心标记（含触控友好的容差）。
   * 用于区分「拖动轴心」与「旋转画面」两种意图。
   */
  hitPivot(px, py, ow, oh) {
    if (this.pivot !== 'custom') return false;
    const ohh = oh || this.deps.getOutputSize().h;
    const c = this.pivotPixel(ow, ohh);
    // 命中半径与 app.js 里绘制的标记尺寸保持一致（R = max(10, w*0.075)），
    // 再留一点余量让手指/鼠标更容易抓住
    const r = Math.max(14, ow * 0.1);
    return Math.hypot(px - c.x, py - c.y) <= r;
  }

  /** 把局部坐标设为新的旋转中心 */
  setPivotAt(px, py, ow, oh) {
    if (this.pivot !== 'custom') return;
    this.pivotXY = {
      x: Math.min(1, Math.max(0, px / ow)),
      y: Math.min(1, Math.max(0, py / oh)),
    };
    this.deps.onChange();
  }

  /**
   * 把前景画布按当前角度渲染到 ctx 上。
   * 返回 true 表示已接管渲染（调用方不要再画原图）。
   *
   * 关键：只要角度模式开着就**始终接管**，哪怕参数还是中性。
   * 否则「启用角度但未调参数」时走 drawImage 路径（构图正常），
   * 一旦动了滑块切到矩阵路径，构图会突变——两条路径必须产出一致结果。
   */
  renderForeground(ctx, ow, oh) {
    const st = this.deps.getState();
    if (!st.maskCanvas) return false;
    const m = this.matrix();
    renderTransformed(ctx, st.maskCanvas, m, ow, oh);
    return true;
  }

  /**
   * 应用镜头畸变（作为后处理，作用在整幅前景上）。
   * 用低分辨率网格反向映射，够用且快。
   */
  applyDistort(ctx, ow, oh) {
    const k = this.params.distort || 0;
    if (!k) return;
    const src = ctx.getImageData(0, 0, ow, oh);
    const dst = ctx.createImageData(ow, oh);
    const cx = ow / 2;
    const cy = oh / 2;
    const nrm = 2 / Math.max(ow, oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const dx = (x - cx) * nrm;
        const dy = (y - cy) * nrm;
        const f = 1 + k * (dx * dx + dy * dy);
        const sx = Math.round(cx + (x - cx) * f);
        const sy = Math.round(cy + (y - cy) * f);
        const di = (y * ow + x) * 4;
        if (sx < 0 || sy < 0 || sx >= ow || sy >= oh) {
          dst.data[di + 3] = 0;
          continue;
        }
        const si = (sy * ow + sx) * 4;
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
    ctx.putImageData(dst, 0, 0);
  }

  /* ---------- 参数导出 / 导入 ---------- */

  /** 把当前参数导出为 .json 文件（可跨会话恢复、可分享） */
  exportParams() {
    const st = this.deps.getState();
    const out = this.deps.getOutputSize();
    const payload = {
      app: 'id-photo-studio',
      kind: 'angle-params',
      version: 1,
      savedAt: new Date().toISOString(),
      output: { w: out.w, h: out.h },
      source: { w: st.W, h: st.H },
      params: this.getParams(),
      pivot: { mode: this.pivot, xy: this.pivotXY },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '角度参数.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    this.deps.toast('参数已导出');
  }

  /** 从 .json 文件恢复参数；尺寸不匹配时按比例换算并提示 */
  async importParams(file) {
    try {
      const txt = await file.text();
      const data = JSON.parse(txt);
      if (!data || data.kind !== 'angle-params' || !data.params) throw new Error('不是角度参数文件');
      const out = this.deps.getOutputSize();
      const src = this.deps.getState();
      let warn = '';
      if (data.output && (data.output.w !== out.w || data.output.h !== out.h)) warn = '（输出尺寸已变化，已按比例套用）';
      if (data.source && (Math.abs(data.source.w - src.W) / src.W > 0.02 || Math.abs(data.source.h - src.H) / src.H > 0.02)) {
        warn = '（源图不同，效果仅供参考）';
      }
      this.params = { ...defaultParams(), ...data.params };
      if (data.pivot) {
        this.pivot = data.pivot.mode || 'center';
        this.pivotXY = data.pivot.xy || { x: 0.5, y: 0.5 };
        this.pivotModeUI();
      }
      this._syncSliders();
      this.deps.onChange();
      this.commit('导入参数');
      this.deps.toast('参数已导入' + warn);
    } catch (err) {
      this.deps.toast('导入失败：' + (err.message || '文件格式不对'));
    }
  }

  /* ---------- 历史 ---------- */

  snapshot() {
    return { params: this.params, mode: this.mode, pivot: this.pivot, pivotXY: this.pivotXY };
  }

  initHistory() {
    this.history.reset(this.snapshot(), '上传完成');
    this._syncHistoryUI(this.history.status());
  }

  commit(label, merge = false) {
    this.history.commit(this.snapshot(), label, merge);
  }

  seal() {
    this.history.seal();
  }

  undo() {
    const s = this.history.undo();
    if (!s) {
      this.deps.toast('没有可撤销的操作');
      return;
    }
    this._apply(s);
    this.deps.toast('已撤销');
  }

  redo() {
    const s = this.history.redo();
    if (!s) {
      this.deps.toast('没有可重做的操作');
      return;
    }
    this._apply(s);
    this.deps.toast('已重做');
  }

  resetAll() {
    this.params = defaultParams();
    this._syncSliders();
    this.deps.onChange();
    this.commit('全部复位');
  }

  resetCurrentGroup() {
    const keys = GROUPS[this.mode] || [];
    for (const k of keys) {
      const def = ANGLE_PARAMS.find((p) => p.key === k);
      if (def) this.params[k] = def.def; // 用 def 而非 0（rotate/roll/pitch/yaw 恰为 0，其余不为 0）
    }
    this._syncSliders();
    this.deps.onChange();
    this.commit('复位本组');
  }

  /** 回到原图：所有参数回默认值 + 清空历史，栈底重设 */
  resetPhoto() {
    this.params = defaultParams();
    this._syncSliders();
    this.deps.onChange();
    this.history.reset(this.snapshot(), '回到原图');
    this._syncHistoryUI(this.history.status());
    this.deps.toast('已回到原图');
  }

  _apply(s) {
    this.params = { ...defaultParams(), ...s.params };
    this.mode = s.mode || 'rotate';
    this.pivot = s.pivot || 'center';
    this.pivotXY = s.pivotXY || { x: 0.5, y: 0.5 };
    this._syncSliders();
    this._syncModeUI();
    this.deps.onChange();
  }

  /* ---------- UI 构建 ---------- */

  _buildUI() {
    const box = $('#angleSliders');
    if (!box) return;
    box.innerHTML = ANGLE_PARAMS.map(
      (p) => `
      <div class="angle-row" data-key="${p.key}">
        <div class="angle-head">
          <label>${p.label}${p.unit ? ` <span class="u">${p.unit}</span>` : ''}</label>
          <input class="angle-num" type="number" data-key="${p.key}"
                 min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}" />
        </div>
        <input class="angle-range" type="range" data-key="${p.key}"
               min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}" />
        <p class="angle-hint">${p.hint || ''}</p>
      </div>`
    ).join('');

    // 滑块 + 数值双向绑定
    box.querySelectorAll('.angle-range').forEach((el) => {
      const key = el.dataset.key;
      el.addEventListener('input', () => {
        let v = +el.value;
        v = this._snap(key, v);
        this.params[key] = v;
        const num = box.querySelector(`.angle-num[data-key="${key}"]`);
        if (num) num.value = fmt(v);
        this.deps.onChange();
        this.commit(labelOf(key), true);
      });
      el.addEventListener('change', () => this.seal());
      el.addEventListener('pointerup', () => this.seal());
    });

    box.querySelectorAll('.angle-num').forEach((el) => {
      const key = el.dataset.key;
      const apply = () => {
        const def = ANGLE_PARAMS.find((p) => p.key === key);
        let v = parseFloat(el.value);
        if (Number.isNaN(v)) return;
        v = Math.min(def.max, Math.max(def.min, v));
        v = this._snap(key, v); // 与滑块通道保持一致：数值输入同样走水平吸附
        this.params[key] = v;
        el.value = fmt(v); // 回写吸附后的值，否则输入框显示的是吸附前的数字
        const range = box.querySelector(`.angle-range[data-key="${key}"]`);
        if (range) range.value = String(v);
        this.deps.onChange();
        this.commit(labelOf(key));
      };
      el.addEventListener('change', apply);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          apply();
          el.blur();
        }
      });
    });

    // 快捷模式
    $('#angleMode')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      this.mode = b.dataset.m;
      this._syncModeUI();
    });

    // 旋转中心
    $('#pivotMode')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      this.pivot = b.dataset.p;
      if (this.pivot !== 'custom' && this.pivot !== 'face') this.pivotXY = { x: 0.5, y: 0.5 };
      this.pivotModeUI();
      this.deps.onChange();
    });

    $('#angleReset')?.addEventListener('click', () => this.resetCurrentGroup());
    $('#angleResetAll')?.addEventListener('click', () => this.resetAll());
    $('#btnUndo')?.addEventListener('click', () => this.undo());
    $('#btnRedo')?.addEventListener('click', () => this.redo());
    $('#btnResetPhoto')?.addEventListener('click', () => this.resetPhoto());
    $('#btnExportJson')?.addEventListener('click', () => this.exportParams());
    $('#btnImportJson')?.addEventListener('click', () => $('#fileJson')?.click());
    $('#fileJson')?.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.importParams(f);
      e.target.value = '';
    });

    // 画布已聚焦时支持方向键微调（1° 粗调 / Shift 0.1° 细调）
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 1, ArrowDown: -1 };
      const dir = map[e.key];
      if (dir === undefined) return;
      e.preventDefault();
      this.nudge(dir, e.shiftKey ? 1 : 10);
      this.commit('键盘微调', true);
    });

    $('#gridOn')?.addEventListener('change', (e) => {
      this.grid = e.target.checked;
      this.deps.onChange();
    });
    $('#snapLevel')?.addEventListener('change', (e) => {
      this.snapLevel = e.target.checked;
    });
  }

  _syncModeUI() {
    const box = $('#angleMode');
    if (box) {
      box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === this.mode));
    }
    const hint = $('#angleHint');
    if (hint) {
      const map = {
        rotate: '拖动画布上的圆环手柄可直接旋转。',
        roll: '左右拖动画面：绕视线轴倾斜，用于纠正歪头。',
        yaw: '左右拖动画面：绕垂直轴转动，用于纠正侧脸。',
        pitch: '上下拖动画面：俯仰纠正，用于仰拍 / 俯拍。',
        persp: '拖动画面四角可矫正梯形透视变形。',
      };
      hint.textContent = map[this.mode] || '';
    }
    // 只高亮当前模式相关的滑块
    const keys = GROUPS[this.mode] || [];
    document.querySelectorAll('.angle-row').forEach((row) => {
      row.classList.toggle('dim', !keys.includes(row.dataset.key));
    });
  }

  pivotModeUI() {
    const box = $('#pivotMode');
    if (!box) return;
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === this.pivot));
  }

  _syncSliders() {
    document.querySelectorAll('.angle-range, .angle-num').forEach((el) => {
      const key = el.dataset.key;
      if (!key) return;
      const v = this.params[key];
      if (typeof v === 'number') el.value = el.classList.contains('angle-num') ? fmt(v) : String(v);
    });
  }

  _syncHistoryUI(st) {
    const u = $('#btnUndo');
    const r = $('#btnRedo');
    if (u) {
      u.disabled = !st.canUndo;
      u.classList.toggle('off', !st.canUndo);
    }
    if (r) {
      r.disabled = !st.canRedo;
      r.classList.toggle('off', !st.canRedo);
    }
    const h = $('#histHint');
    if (h) h.textContent = `${st.label || '—'} ｜ 可撤销 ${st.index} 步 / 共 ${st.size} 步`;
    const s = $('#histStep');
    if (s) s.textContent = `${st.index + 1} / ${st.size}`;
  }

  /** 水平吸附：rotate 在 ±2° 内归零 */
  _snap(key, v) {
    if (!this.snapLevel) return v;
    if (key === 'rotate' && Math.abs(v) <= 2) return 0;
    return v;
  }

  /* ---------- 键盘微调 ---------- */

  /**
   * 方向键微调。
   * @param {number} dir   -1 / +1
   * @param {number} factor 1 = 细调（一个 step），10 = 粗调（十个 step）
   *
   * 注意：微调**不做吸附归零**。吸附的语义是「靠近水平时帮你归零」，
   * 而方向键的语义是「我要精确控制」。若微调也走吸附，1° 的步长落在
   * ±2° 吸附区内会被立刻吸回 0，用户按方向键将永远调不动。
   */
  nudge(dir, factor = 1) {
    const key = this.mode;
    const def = ANGLE_PARAMS.find((p) => p.key === key);
    if (!def) return false;
    const delta = def.step * factor * dir;
    const cur = this.params[key] ?? def.def;
    let next = cur + delta;
    // 允许「一步跨出吸附区」：若起点在吸附区内且这一步会离开，直接采用目标值
    next = clampv(next, def.min, def.max);
    this.params[key] = roundTo(next, def.step);
    this._syncSliders();
    this.deps.onChange();
    return true;
  }

  /* ---------- 画布拖拽 ---------- */

  /** 由 app.js 在 pointerdown 时调用；返回 true 表示已接管这次拖拽 */
  beginDrag(localX, localY) {
    if (!this.enabled) return false;
    return true;
  }

  /**
   * 拖拽更新。
   * @param {number} dx 归一化水平位移（相对画布宽）
   * @param {number} dy 归一化垂直位移（相对画布高）
   * @param {object} [ctxInfo] { px, py, ow, oh } 当前局部坐标与画布尺寸，
   *                           用于「拖动轴心」这一分支
   */
  drag(dx, dy, ctxInfo) {
    if (!this.enabled) return false;

    // 分支一：正在拖动旋转中心标记
    if (this.movingPivot && ctxInfo) {
      this.setPivotAt(ctxInfo.px, ctxInfo.py, ctxInfo.ow, ctxInfo.oh);
      return true;
    }

    const SENS = { rotate: 42, pitch: 28 };
    switch (this.mode) {
      case 'rotate':
        this.params.rotate = clampv(this.params.rotate + dx * SENS.rotate, -45, 45);
        break;
      case 'pitch':
        this.params.pitch = clampv(this.params.pitch - dy * SENS.pitch, -25, 25);
        break;
      default:
        return false;
    }
    this._syncSliders();
    this.deps.onChange();
    return true;
  }

  endDrag() {
    if (!this.enabled) return;
    if (this.movingPivot) {
      this.movingPivot = false;
      this.commit('移动旋转中心');
      this.seal();
      return;
    }
    this.commit('拖拽' + (labelOf(this.mode) || ''), false);
    this.seal();
  }
}

function clampv(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** 按步长归整，避免 0.1 累加产生 2.3000000000000003 这类浮点噪声 */
function roundTo(v, step) {
  const n = Math.round(v / step);
  return Math.round(n * step * 1e6) / 1e6;
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000);
}

function labelOf(key) {
  const def = ANGLE_PARAMS.find((p) => p.key === key);
  return def ? def.label : '角度调整';
}
