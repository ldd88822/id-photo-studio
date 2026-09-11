// 像素级渲染验证：用纯 Node + 轻量 canvas 垫片校验 renderTransformed
// 校验点：alpha 采样正确、无黑边（预乘还原）、旋转后位置正确、边缘不外溢

class FakeCtx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(this.data) };
  }
  putImageData(img) {
    this.data.set(img.data);
  }
  clearRect() {}
  fillRect() {}
}

class FakeCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this._ctx = new FakeCtx(w, h);
  }
  getContext() {
    return this._ctx;
  }
}

globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') return new FakeCanvas(1, 1);
    return {};
  },
};

const { renderTransformed, buildMatrix, defaultParams } = await import('./js/transform.js');

let pass = 0;
let fail = 0;
const t = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}  ${e}`); }
};

// 构造 16×16 全不透明红块（源图与输出同尺寸，旋转后仍能覆盖中心）
const SRC_N = 16;
const src = new FakeCanvas(SRC_N, SRC_N);
for (let i = 0; i < SRC_N * SRC_N; i++) {
  src._ctx.data[i * 4] = 255;
  src._ctx.data[i * 4 + 1] = 0;
  src._ctx.data[i * 4 + 2] = 0;
  src._ctx.data[i * 4 + 3] = 255;
}

console.log('\n[8] 像素渲染');
{
  const N = 16;
  // 源图铺满输出：矩阵 = 输出→源坐标，同尺寸时为单位阵
  const out = new FakeCanvas(N, N);
  const octx = out.getContext();
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  renderTransformed(octx, src, m, N, N);
  const at = (x, y) => {
    const i = (y * N + x) * 4;
    return { r: octx.data[i], g: octx.data[i + 1], b: octx.data[i + 2], a: octx.data[i + 3] };
  };
  const c = at(8, 8);
  t('中心像素为红色且不透明', c.r === 255 && c.g === 0 && c.a === 255, JSON.stringify(c));
  t('四角全部不透明（完整覆盖）', at(0, 0).a === 255 && at(N - 1, 0).a === 255 && at(0, N - 1).a === 255 && at(N - 1, N - 1).a === 255);
  // 关键：不能出现黑边 —— 若有预乘 bug，边缘像素会呈暗红
  let darkEdge = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = at(x, y);
      if (p.a > 200 && p.r < 240 && p.g < 10 && p.b < 10) darkEdge++;
    }
  }
  t('无黑边（预乘 alpha 还原正确）', darkEdge === 0, `暗像素 ${darkEdge} 个`);

  // 旋转 90° 后中心应保持不透明（旋转中心不动点）
  for (const deg of [90, 45, -30, 180]) {
    const o = new FakeCanvas(N, N);
    const oc = o.getContext();
    renderTransformed(oc, src, buildMatrix({ ...defaultParams(), rotate: deg }, N, N, SRC_N, SRC_N), N, N);
    const ci = (8 * N + 8) * 4;
    t(`旋转 ${deg}° 后中心仍不透明`, oc.data[ci + 3] > 200, `a=${oc.data[ci + 3]} r=${oc.data[ci]}`);
  }

  // 半透明源：alpha 应正确保留、色相不失真
  const src2 = new FakeCanvas(8, 8);
  for (let i = 0; i < 64; i++) {
    src2._ctx.data[i * 4] = 255;
    src2._ctx.data[i * 4 + 3] = 128;
  }
  const out4 = new FakeCanvas(8, 8);
  const o4 = out4.getContext();
  renderTransformed(o4, src2, [1, 0, 0, 0, 1, 0, 0, 0, 1], 8, 8);
  const i4 = (4 * 8 + 4) * 4;
  t('半透明源保留 alpha 且色相不变', o4.data[i4] > 240 && o4.data[i4 + 3] > 100 && o4.data[i4 + 3] < 160,
    `r=${o4.data[i4]} a=${o4.data[i4 + 3]}`);

  // 平移：整体右移后左侧应透明
  const out5 = new FakeCanvas(N, N);
  const o5 = out5.getContext();
  renderTransformed(o5, src, [1, 0, -8, 0, 1, 0, 0, 0, 1], N, N);
  t('矩阵平移后超出部分留透明', o5.data[(8 * N + 0) * 4 + 3] === 0 && o5.data[(8 * N + 15) * 4 + 3] === 255,
    `左 a=${o5.data[(8 * N + 0) * 4 + 3]} 右 a=${o5.data[(8 * N + 15) * 4 + 3]}`);

  // alpha 全 0 区域应保持透明（不被背景色污染）
  const src3 = new FakeCanvas(8, 8);
  const out6 = new FakeCanvas(8, 8);
  const o6 = out6.getContext();
  o6.data.fill(0);
  renderTransformed(o6, src3, [1, 0, 0, 0, 1, 0, 0, 0, 1], 8, 8);
  t('全透明源不产生任何像素', o6.data.every((v) => v === 0));
}

console.log(`\n===== 像素测试 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
