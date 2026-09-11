// 几何变换引擎：3D 旋转 / 透视校正 / 镜头畸变
// 坐标系约定：照片空间以「输出画布」为单位（w×h），绕画布中心旋转，
// 逆变换时把输出像素映射回源图（S.maskCanvas）的像素位置，用双线性采样取值。

/* ==================== 矩阵基础（3×3 齐次） ==================== */

export function identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function multiply(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function mulVec(m, x, y) {
  const d = m[6] * x + m[7] * y + m[8];
  const s = d === 0 ? 1e-9 : d;
  return { x: (m[0] * x + m[1] * y + m[2]) / s, y: (m[3] * x + m[4] * y + m[5]) / s };
}

/** 解 8×8 线性方程组（高斯消元 + 列主元），返回解向量或 null */
function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = M[piv];
      M[piv] = M[col];
      M[col] = t;
    }
    const p = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** 由 4 组「目标点 → 源点」对应关系求透视矩阵（输出像素 → 源图像素） */
export function perspectiveFrom4(dst, src) {
  // dst: 输出画布上的四边形顶点, src: 源图上的对应点
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const s = solve8(A, b);
  if (!s) return identity();
  return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
}

/* ==================== 基础变换矩阵 ==================== */

/** 绕点 (cx,cy) 旋转 deg（图像空间，正数=顺时针） */
export function rotateDeg(deg, cx, cy) {
  const r = (deg * Math.PI) / 180;
  const co = Math.cos(r);
  const si = Math.sin(r);
  return [co, -si, cx - co * cx + si * cy, si, co, cy - si * cx - co * cy, 0, 0, 1];
}

export function scaleXY(sx, sy, cx, cy) {
  return [sx, 0, cx - sx * cx, 0, sy, cy - sy * cy, 0, 0, 1];
}

export function translate(tx, ty) {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

/**
 * 3D 旋转投影矩阵。
 * pitch：绕水平轴（低头/抬头），yaw：绕垂直轴（转头），roll：画面内旋转。
 * 三者都以 deg 传入，作用在归一化坐标（x,y ∈ [-1,1]）。
 */
export function rotation3D(pitch, yaw, roll, fov) {
  const d = Math.max(0.4, fov); // 相机距离，越小透视越强
  const px = (pitch * Math.PI) / 180;
  const py = (yaw * Math.PI) / 180;
  const pz = (roll * Math.PI) / 180;

  const cp = Math.cos(px);
  const sp = Math.sin(px);
  const cy = Math.cos(py);
  const sy = Math.sin(py);
  const cz = Math.cos(pz);
  const sz = Math.sin(pz);

  // R = Rz(roll) · Ry(yaw) · Rx(pitch)
  const R = [
    cz * cy, cz * sy * sp - sz * cp, cz * sy * cp + sz * sp,
    sz * cy, sz * sy * sp + cz * cp, sz * sy * cp - cz * sp,
    -sy, cy * sp, cy * cp,
  ];

  // 相机位于 +z 方向、距离 d 处，看向 -z。
  // 空间点 P = (x, y, 0) 绕原点旋转后为 P' = R·P。
  // 透视投影：u = x' / (1 + z'/d)，v = y' / (1 + z'/d)
  // 写成齐次形式 [m0 m1 1; m3 m4 1; m6 m7 1]：
  //   m0 = R00, m1 = R01, m2 = 0
  //   m3 = R10, m4 = R11, m5 = 0
  //   m6 = R20/d, m7 = R21/d, m8 = 1
  // 这样分母 = R20*x/d + R21*y/d + 1 = 1 + z'/d ✓
  return [
    R[0], R[1], 0,
    R[3], R[4], 0,
    R[6] / d, R[7] / d, 1,
  ];
}

/** 镜头畸变（桶形 k>0 / 枕形 k<0），返回「目标 → 源」的逆向映射矩阵不可表达，单独用径向函数 */
export function distortFactor(k1, dx, dy) {
  const r2 = dx * dx + dy * dy;
  return 1 + k1 * r2;
}

/* ==================== 变换栈 ==================== */

/**
 * 由参数对象构建「输出像素 → 源图像素」的完整矩阵。
 * params: { rotate, roll, pitch, yaw, perspX, perspY, zoom, distort, fov }
 * 输出画布尺寸 ow×oh，源图尺寸 sw×sh，可选旋转中心 pivot（像素坐标，默认画布中心）。
 *
 * 关键点：乘法顺序。若 M = A·B，则先施加 B 再施加 A（右结合）。
 * 我们需要「输出像素 → 源图像素」的链路，因此从最外层（缩放）往内层
 * （源图 cover 铺排）依次左乘。
 */
export function buildMatrix(params, ow, oh, sw, sh, pivot, view) {
  const w = ow;
  const h = oh;
  const mx = w / 2; // 画布中心：cover 铺排始终以此为基准
  const my = h / 2;
  const cx = pivot ? pivot.x : mx; // 旋转中心：pivot 只作用于几何链
  const cy = pivot ? pivot.y : my;

  // ① 基准映射：源图按 cover 铺满输出画布，并把「源图像素」反查成「输出像素」。
  //
  //    矩阵链的方向是「输出像素 → 源图像素」，所以这里必须用**逆映射**：
  //    正向是把源图画大 k 倍铺满画布，逆映射就是缩小 1/k。
  //    k = max(ow/sw, oh/sh) 是正向放大倍数；逆映射的缩放因子是 1/k。
  //    （早期版本直接把 k 当作逆映射因子，只在 ow==sw 且 oh==sh 时才碰巧正确。）
  //
  //    view 承接主应用的 S.tf（scale / nx / ny），把「自动构图 + 用户平移缩放」纳入进来；
  //    缺省时退化为居中铺满。
  const vScale = view && view.scale ? view.scale : 1;
  const vnx = view && typeof view.nx === 'number' ? view.nx : 0.5;
  const vny = view && typeof view.ny === 'number' ? view.ny : 0.5;
  const k = Math.max(w / sw, h / sh) * vScale; // 正向放大倍数
  // 画布上源图左上角的位置（正向）：左上 = (vnx*w - sw*k/2, vny*h - sh*k/2)
  // 逆映射：源 = (输出 - 左上) / k
  const offX = vnx * w - (sw * k) / 2;
  const offY = vny * h - (sh * k) / 2;
  const cover = multiply(scaleXY(1 / k, 1 / k, 0, 0), translate(-offX, -offY));

  // 组装「画布坐标 → 画布坐标」的几何链（不含 cover），最后再套 cover。
  // 这样旋转/透视都以画布中心为基准，不会被 cover 的缩放系数污染。
  let geo = identity();

  // ② 画面内旋转（2D，绕画布中心）
  if (params.rotate) geo = multiply(rotateDeg(params.rotate, cx, cy), geo);

  // ③ 3D 旋转（归一化坐标：nx = 2x/w - 1）
  const has3D = params.pitch || params.yaw || params.roll;
  if (has3D) {
    const r3 = rotation3D(params.pitch || 0, params.yaw || 0, params.roll || 0, params.fov || 1.8);
    const toNorm = [2 / w, 0, -1, 0, 2 / h, -1, 0, 0, 1];
    const fromNorm = [w / 2, 0, cx, 0, h / 2, cy, 0, 0, 1];
    geo = multiply(multiply(fromNorm, r3), multiply(toNorm, geo));
  }

  // ④ 透视校正：输出画布 → 源图上的梯形
  //    方向语义：perspX > 0 → 视觉「顶边收窄」；perspY > 0 → 视觉「左边收窄」。
  //
  //    注意映射方向：矩阵是「输出 → 源图」，srcQuad 描述「输出矩形四角各自到源图哪里取样」。
  //      · 想让输出顶边**看起来更窄**，就得让输出顶边取源图**更宽**的一段
  //        （把宽的一段压进窄的顶边 ⇒ 视觉顶部收缩）。
  //        所以顶边横向系数是 1 + px。
  //      · 同理，想让输出左边看起来更窄，左边取源图更高的竖向区间，系数 1 + py。
  //
  //    四个顶点必须各自独立控制，才能形成真正的梯形：
  //      · 顶边两点的 x 由 (1+px) 决定（水平收窄）
  //      · 左边/右边两点的 y 区间由 (1+py) 决定（垂直收窄）
  //    早期版本把 py 同时加到顶边两点的 y 上，得到的是「顶边整体上移」，
  //    等价于纵向缩放而非纵向梯形 —— 这是错的。
  //
  //    梯形以**画布中心** mx/my 为基准，不受 pivot 影响 ——
  //    透视是「整幅画面的形状矫正」，与旋转中心无关。
  const px = params.perspX || 0;
  const py = params.perspY || 0;
  if (px || py) {
    const dst = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const halfW = w / 2;
    const halfH = h / 2;
    // 顶边横向半宽：px>0 时更宽（视觉顶部收窄）
    const topHalfW = halfW * (1 + px);
    // 左边纵向半高：py>0 时更高（视觉左侧收窄）
    const leftHalfH = halfH * (1 + py);
    const srcQuad = [
      { x: mx - topHalfW, y: my - leftHalfH }, // 左上
      { x: mx + topHalfW, y: my - halfH },     // 右上
      { x: mx + halfW, y: my + leftHalfH },    // 右下
      { x: mx - halfW, y: my + halfH },        // 左下
    ];
    geo = multiply(perspectiveFrom4(dst, srcQuad), geo);
  }

  // ⑤ 缩放（最外层）
  const z = params.zoom || 1;
  if (z !== 1) geo = multiply(scaleXY(z, z, cx, cy), geo);

  // ⑥ 套上 cover：先做 geo（画布坐标变换），再映射到源图
  return multiply(cover, geo);
}

/** 判断矩阵是否为恒等（免走慢路径） */
export function isIdentityMatrix(m) {
  const e = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) if (Math.abs(m[i] - e[i]) > 1e-9) return false;
  return true;
}

/* ==================== 渲染 ==================== */

/**
 * 把带 alpha 的前景画布按矩阵映射渲染到目标 ctx。
 * 用双线性采样 + 预乘 alpha 避免边缘出现黑边。
 */
export function renderTransformed(ctx, srcCanvas, m, ow, oh) {
  const out = ctx.getImageData(0, 0, ow, oh);
  const od = out.data;
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, sw, sh).data;

  const [a, b, c, d, e, f, g, h_, i] = m;

  for (let y = 0; y < oh; y++) {
    const yc = y;
    for (let x = 0; x < ow; x++) {
      const den = g * x + h_ * yc + i;
      if (den === 0) continue;
      const sx = (a * x + b * yc + c) / den;
      const sy = (d * x + e * yc + f) / den;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue;

      // 双线性采样
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const idx = (y * ow + x) * 4;
      let r = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      for (let j = 0; j <= 1; j++) {
        for (let k = 0; k <= 1; k++) {
          const xx = clampInt(x0 + k, 0, sw - 1);
          const yy = clampInt(y0 + j, 0, sh - 1);
          const wgt = (k ? fx : 1 - fx) * (j ? fy : 1 - fy);
          if (wgt <= 0) continue;
          const si = (yy * sw + xx) * 4;
          const sa = sd[si + 3] / 255;
          r += sd[si] * sa * wgt;
          gg += sd[si + 1] * sa * wgt;
          bb += sd[si + 2] * sa * wgt;
          aa += sa * wgt;
        }
      }
      if (aa <= 0.0001) continue;
      // 预乘还原
      const nr = r / aa;
      const ng = gg / aa;
      const nb = bb / aa;
      const na = Math.min(1, aa);
      // 与现有背景做 source-over 叠加
      const da = od[idx + 3] / 255;
      const oa = na + da * (1 - na);
      if (oa <= 0) continue;
      od[idx] = (nr * na + od[idx] * da * (1 - na)) / oa;
      od[idx + 1] = (ng * na + od[idx + 1] * da * (1 - na)) / oa;
      od[idx + 2] = (nb * na + od[idx + 2] * da * (1 - na)) / oa;
      od[idx + 3] = oa * 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function clampInt(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/* ==================== 参数定义 ==================== */

export const ANGLE_PARAMS = [
  { key: 'rotate', label: '水平旋转', unit: '°', min: -45, max: 45, step: 0.1, def: 0, hint: '整幅画面左右摆正' },
  { key: 'roll', label: '倾斜（Roll）', unit: '°', min: -30, max: 30, step: 0.1, def: 0, hint: '绕视线轴倾斜，纠正歪头' },
  { key: 'yaw', label: '转头（Yaw）', unit: '°', min: -25, max: 25, step: 0.1, def: 0, hint: '绕垂直轴转动，纠正侧脸' },
  { key: 'pitch', label: '俯仰（Pitch）', unit: '°', min: -25, max: 25, step: 0.1, def: 0, hint: '绕水平轴俯仰，纠正仰拍/俯拍' },
  { key: 'perspX', label: '横向透视', min: -0.4, max: 0.4, step: 0.005, def: 0, hint: '矫正左右梯形变形' },
  { key: 'perspY', label: '纵向透视', min: -0.4, max: 0.4, step: 0.005, def: 0, hint: '矫正上下梯形变形' },
  { key: 'zoom', label: '画面缩放', min: 0.5, max: 2, step: 0.005, def: 1, hint: '补偿旋转后的留白' },
  { key: 'distort', label: '镜头畸变', min: -0.3, max: 0.3, step: 0.005, def: 0, hint: '桶形 / 枕形畸变校正（整幅后处理）' },
  { key: 'fov', label: '镜头距离', min: 0.8, max: 4, step: 0.05, def: 1.8, hint: '越小透视越强（3D 旋转生效时）' },
];

export function defaultParams() {
  const o = {};
  for (const p of ANGLE_PARAMS) o[p.key] = p.def;
  return o;
}

export function isNeutral(params) {
  for (const p of ANGLE_PARAMS) {
    const def = p.def;
    if (Math.abs((params[p.key] ?? def) - def) > 1e-6) return false;
  }
  return true;
}
