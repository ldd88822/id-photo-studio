import {
  identity, multiply, mulVec, perspectiveFrom4, rotateDeg, scaleXY, translate,
  rotation3D, buildMatrix, isIdentityMatrix, defaultParams, isNeutral, ANGLE_PARAMS,
} from './js/transform.js';
import { History } from './js/history.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

console.log('\n[1] 矩阵基础');
{
  const I = identity();
  const p = mulVec(I, 3, 5);
  t('单位矩阵不变换', near(p.x, 3) && near(p.y, 5));

  const T = translate(10, -4);
  const q = mulVec(T, 3, 5);
  t('平移正确', near(q.x, 13) && near(q.y, 1));

  const S = scaleXY(2, 3, 0, 0);
  const r = mulVec(S, 2, 2);
  t('缩放正确', near(r.x, 4) && near(r.y, 6));

  // rotateDeg 顺时针 90°: (1,0) 绕原点 -> (0,1)（图像坐标 y 向下）
  const R = rotateDeg(90, 0, 0);
  const s = mulVec(R, 1, 0);
  t('旋转 90° 方向正确（图像坐标顺时针）', near(s.x, 0, 1e-9) && near(s.y, 1, 1e-9), `得到 ${s.x.toFixed(3)},${s.y.toFixed(3)}`);

  const R2 = rotateDeg(180, 5, 5);
  const u = mulVec(R2, 5, 0);
  t('绕非原点旋转 180°', near(u.x, 5) && near(u.y, 10));
}

console.log('\n[2] 透视矩阵求解');
{
  // 已知透视关系：把 (0,0)(100,0)(100,100)(0,100) 映射到内缩四边形
  const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const src = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }];
  const M = perspectiveFrom4(dst, src);
  let ok = true;
  for (let i = 0; i < 4; i++) {
    const g = mulVec(M, dst[i].x, dst[i].y);
    if (!near(g.x, src[i].x, 1e-6) || !near(g.y, src[i].y, 1e-6)) ok = false;
  }
  t('4 点透视映射精确回代', ok);
}

console.log('\n[3] 3D 旋转');
{
  // 无旋转时应为单位阵
  const R0 = rotation3D(0, 0, 0, 1.8);
  t('零角度 = 单位投影', near(R0[0], 1) && near(R0[4], 1) && near(R0[8], 1));

  // roll 90° 在归一化坐标下 (0,1) 应变为 (-1,0) 或 (1,0) 之一（取决于约定）
  const Rr = rotation3D(0, 0, 90, 1.8);
  const a = mulVec(Rr, 1, 0);
  t('roll 旋转产生位移', Math.abs(a.x - 1) > 0.5 || Math.abs(a.y) > 0.5, `得到 ${a.x.toFixed(3)},${a.y.toFixed(3)}`);

  // yaw 应产生透视：一侧被放大、一侧被缩小（近大远小）
  const Ry = rotation3D(0, 25, 0, 1.8);
  const bL = mulVec(Ry, -0.9, 0);
  const bR = mulVec(Ry, 0.9, 0);
  t('yaw 产生近大远小（左右不对称）', Math.abs(bL.x) !== Math.abs(bR.x),
    `左 ${bL.x.toFixed(3)} 右 ${bR.x.toFixed(3)}`);
  t('yaw 保持中心不动', (() => { const c = mulVec(Ry, 0, 0); return near(c.x, 0, 1e-9) && near(c.y, 0, 1e-9); })());

  // 对称性：yaw +25 与 -25 应镜像
  const Ry2 = rotation3D(0, -25, 0, 1.8);
  const cS = mulVec(Ry2, -0.9, 0);
  const cS2 = mulVec(Ry2, 0.9, 0);
  t('yaw 正负对称（镜像）', near(bL.x, -cS2.x, 1e-9) && near(bR.x, -cS.x, 1e-9),
    `+25: ${bL.x.toFixed(3)}/${bR.x.toFixed(3)}  -25: ${cS.x.toFixed(3)}/${cS2.x.toFixed(3)}`);

  // pitch 同理
  const Rp = rotation3D(20, 0, 0, 1.8);
  const pU = mulVec(Rp, 0, -0.9);
  const pD = mulVec(Rp, 0, 0.9);
  t('pitch 产生上下近大远小', Math.abs(pU.y) !== Math.abs(pD.y), `${pU.y.toFixed(3)} / ${pD.y.toFixed(3)}`);
}

console.log('\n[4] buildMatrix 整合');
{
  // 矩阵语义：mulVec(M, 输出x, 输出y) → 源图坐标
  const p0 = defaultParams();
  const ow = 295, oh = 413, sw = 1200, sh = 1600;
  const M0 = buildMatrix(p0, ow, oh, sw, sh);
  t('默认参数非恒等（含 cover 缩放）', !isIdentityMatrix(M0));

  // 输出画布中心应反查到源图中心
  const cen = mulVec(M0, ow / 2, oh / 2);
  t('输出中心 → 源图中心', near(cen.x, sw / 2, 0.01) && near(cen.y, sh / 2, 0.01), `得到 ${cen.x.toFixed(2)},${cen.y.toFixed(2)}`);

  // cover 语义：输出画布四角必须落在源图范围内（否则会出现空白边）
  const tl = mulVec(M0, 0, 0);
  const br = mulVec(M0, ow, oh);
  t('输出四角均落在源图内（cover 成立）',
    tl.x >= -0.01 && tl.y >= -0.01 && br.x <= sw + 0.01 && br.y <= sh + 0.01,
    `左上 ${tl.x.toFixed(1)},${tl.y.toFixed(1)} 右下 ${br.x.toFixed(1)},${br.y.toFixed(1)}`);
  // 且至少有一条边贴合（说明确实是 cover 而非 contain）
  const touches = Math.min(Math.abs(tl.x), Math.abs(tl.y), Math.abs(sw - br.x), Math.abs(sh - br.y));
  t('cover 至少一边贴合源图边界', touches < 0.01, `最小间隙 ${touches.toFixed(3)}`);

  // 旋转 0 与 旋转 10 结果应不同
  const p1 = { ...p0, rotate: 10 };
  const M1 = buildMatrix(p1, 295, 413, 1200, 1600);
  let diff = 0;
  for (let i = 0; i < 9; i++) diff += Math.abs(M1[i] - M0[i]);
  t('rotate 参数生效', diff > 1e-3, `diff=${diff.toFixed(4)}`);

  // 各参数单独生效
  for (const key of ['roll', 'yaw', 'pitch', 'perspX', 'perspY']) {
    const pp = { ...p0, [key]: key.startsWith('persp') ? 0.2 : 10 };
    const Mp = buildMatrix(pp, 295, 413, 1200, 1600);
    let d = 0;
    for (let i = 0; i < 9; i++) d += Math.abs(Mp[i] - M0[i]);
    t(`${key} 参数生效`, d > 1e-6, `diff=${d.toExponential(2)}`);
  }

  // zoom
  const pz = { ...p0, zoom: 1.5 };
  const Mz = buildMatrix(pz, 295, 413, 1200, 1600);
  let dz = 0;
  for (let i = 0; i < 9; i++) dz += Math.abs(Mz[i] - M0[i]);
  t('zoom 参数生效', dz > 1e-6);

  // 透视方向语义：perspX > 0 → 顶边取样更宽 → 视觉上顶部收窄
  {
    const pw = 295, ph = 413, psw = 900, psh = 1200;
    const sampleRowWidth = (px, y) => {
      const M = buildMatrix({ ...p0, perspX: px }, pw, ph, psw, psh);
      const a = mulVec(M, 0, y);
      const b = mulVec(M, pw, y);
      return Math.abs(b.x - a.x);
    };
    const topPos = sampleRowWidth(0.2, 0);
    const topNeg = sampleRowWidth(-0.2, 0);
    const botPos = sampleRowWidth(0.2, ph);
    t('perspX>0 时顶边取样宽于底边（视觉顶部收窄）', topPos > botPos, `顶 ${topPos.toFixed(1)} / 底 ${botPos.toFixed(1)}`);
    t('perspX<0 时顶边取样窄于底边（视觉顶部放大）', topNeg < botPos, `顶 ${topNeg.toFixed(1)} / 底 ${botPos.toFixed(1)}`);
    t('perspX 正负对称', Math.abs(topPos - botPos - (botPos - topNeg)) < 1e-6, `${topPos.toFixed(1)} / ${topNeg.toFixed(1)}`);

    // 纵向透视：判据不能用「左右两列的 y 跨度对比」——
    // 射影变换保持对边比，两条对边的跨度恒等，那个指标永远测不出差异。
    // 正确判据：看左右两侧顶点的 y 是否错开（真正的梯形特征）。
    const cornerY = (py) => {
      const M = buildMatrix({ ...p0, perspY: py }, pw, ph, psw, psh);
      return {
        leftTop: mulVec(M, 0, 0).y,
        rightTop: mulVec(M, pw, 0).y,
        leftBottom: mulVec(M, 0, ph).y,
        rightBottom: mulVec(M, pw, ph).y,
      };
    };
    const yPos = cornerY(0.2);
    const yNeg = cornerY(-0.2);
    const yZero = cornerY(0);
    t('perspY=0 时左右顶点 y 齐平', Math.abs(yZero.leftTop - yZero.rightTop) < 1e-6, `${yZero.leftTop},${yZero.rightTop}`);
    t('perspY>0 时左侧顶点纵向外扩（形成梯形）', Math.abs(yPos.leftTop - yPos.rightTop) > 1, `错开 ${Math.abs(yPos.leftTop - yPos.rightTop).toFixed(1)}`);
    t('perspY<0 时梯形方向相反', (yNeg.leftTop - yNeg.rightTop) * (yPos.leftTop - yPos.rightTop) < 0, `正 ${(yPos.leftTop - yPos.rightTop).toFixed(1)} / 负 ${(yNeg.leftTop - yNeg.rightTop).toFixed(1)}`);
    t('perspY 不影响水平方向的梯形', Math.abs(yPos.leftTop - yPos.rightTop) > 1);

    // 横向与纵向应互不干扰
    const mx = buildMatrix({ ...p0, perspX: 0.2 }, pw, ph, psw, psh);
    const tX = Math.abs(mulVec(mx, 0, 0).y - mulVec(mx, pw, 0).y);
    t('perspX 不产生纵向梯形', tX < 1e-6, `纵向错开 ${tX.toFixed(3)}`);
  }
}

console.log('\n[5] 中性判断');
{
  t('默认参数判定为中性', isNeutral(defaultParams()));
  t('改动任一参数后非中性', !isNeutral({ ...defaultParams(), rotate: 1 }));
  t('zoom 偏离 1 非中性', !isNeutral({ ...defaultParams(), zoom: 1.2 }));
  t('distort 非零非中性', !isNeutral({ ...defaultParams(), distort: 0.1 }));
}

console.log('\n[6] 参数范围定义完整性');
{
  const keys = ANGLE_PARAMS.map((p) => p.key);
  t('包含全部可调参数', keys.length === 9, keys.join(','));
  t('范围均有效（min<max, step>0）', ANGLE_PARAMS.every((p) => p.min < p.max && p.step > 0 && p.def >= p.min && p.def <= p.max));
  t('水平旋转范围 ±45°', ANGLE_PARAMS.find((p) => p.key === 'rotate').max === 45);
  t('倾斜/俯仰 ±25~30°', Math.abs(ANGLE_PARAMS.find((p) => p.key === 'roll').max) >= 25);
  t('fov 默认 1.8 且范围有效', ANGLE_PARAMS.find((p) => p.key === 'fov').def === 1.8);
}

console.log('\n[6b] 旋转中心（pivot）');
{
  const P = defaultParams();
  // 绕画布中心旋转 90°：中心不动
  const mC = buildMatrix({ ...P, rotate: 90 }, 200, 300, 200, 300);
  const cC = mulVec(mC, 100, 150);
  t('pivot=中心：旋转 90° 中心不动', Math.abs(cC.x - 100) < 1e-6 && Math.abs(cC.y - 150) < 1e-6, `${cC.x},${cC.y}`);
  // 绕左上角 (0,0) 顺时针旋转 90°：(x,y) → (-y, x)，中心 (100,150) → (-150, 100)
  const mP = buildMatrix({ ...P, rotate: 90 }, 200, 300, 200, 300, { x: 0, y: 0 });
  const cP = mulVec(mP, 100, 150);
  t('pivot=左上角：旋转 90° 中心位移正确', Math.abs(cP.x + 150) < 1e-4 && Math.abs(cP.y - 100) < 1e-4, `${cP.x.toFixed(3)},${cP.y.toFixed(3)}`);
  // pivot 不影响恒等变换
  const mI = buildMatrix(P, 200, 300, 200, 300, { x: 33, y: 77 });
  t('pivot 在恒等参数下仍为恒等', isIdentityMatrix(mI));
}

console.log('\n[6c] 构图状态（view）参与基准映射');
{
  // 矩阵语义：mulVec(M, 输出x, 输出y) → 源图坐标
  const P = defaultParams();
  const sw = 100, sh = 150, ow = 200, oh = 300;
  // 默认 view（居中铺满）：输出画布中心应映射回源图中心
  const mDefault = buildMatrix(P, ow, oh, sw, sh);
  const cDefault = mulVec(mDefault, ow / 2, oh / 2);
  t('默认 view：输出中心 → 源图中心', Math.abs(cDefault.x - sw / 2) < 1e-4 && Math.abs(cDefault.y - sh / 2) < 1e-4, `${cDefault.x.toFixed(3)},${cDefault.y.toFixed(3)}`);

  // 显式传入 0.5/0.5 应与默认一致
  const mSame = buildMatrix(P, ow, oh, sw, sh, null, { scale: 1, nx: 0.5, ny: 0.5 });
  const cSame = mulVec(mSame, ow / 2, oh / 2);
  t('显式 0.5/0.5 等价于默认', Math.abs(cSame.x - cDefault.x) < 1e-9 && Math.abs(cSame.y - cDefault.y) < 1e-9);

  // nx 从 0.5 移到 0.75：画布上右移 0.25*ow = 50px，
  // 但矩阵输出的是**源图坐标**，要再除以正向放大倍数 k 才是源坐标的位移。
  const kForward = Math.max(ow / sw, oh / sh);
  const mShift = buildMatrix(P, ow, oh, sw, sh, null, { scale: 1, nx: 0.75, ny: 0.5 });
  const cShift = mulVec(mShift, ow / 2, oh / 2);
  const expectShift = cDefault.x - (0.25 * ow) / kForward;
  t('nx=0.75 使源坐标按 k 折算左移', Math.abs(cShift.x - expectShift) < 1e-4, `${cShift.x.toFixed(3)} vs ${expectShift.toFixed(3)}`);

  // scale 参与：中心点不变，边缘点向中心靠拢
  const mZoom = buildMatrix(P, ow, oh, sw, sh, null, { scale: 2, nx: 0.5, ny: 0.5 });
  const cZoom = mulVec(mZoom, ow / 2, oh / 2);
  t('view.scale=2 不影响中心点', Math.abs(cZoom.x - cDefault.x) < 1e-4 && Math.abs(cZoom.y - cDefault.y) < 1e-4, `${cZoom.x.toFixed(3)},${cZoom.y.toFixed(3)}`);
  const edgeBase = mulVec(mDefault, 0, oh / 2);
  const edgeZoom = mulVec(mZoom, 0, oh / 2);
  t('view.scale=2 使边缘源坐标向中心靠拢', Math.abs(edgeZoom.x - sw / 2) < Math.abs(edgeBase.x - sw / 2), `${edgeBase.x.toFixed(2)} -> ${edgeZoom.x.toFixed(2)}`);
}

console.log('\n[7] 历史栈');
{
  const h = new History({ limit: 5, mergeMs: 100000 });
  h.reset({ v: 0 }, '初始');
  t('初始不可撤销', h.status().canUndo === false);

  h.commit({ v: 1 }, 'A');
  h.commit({ v: 2 }, 'B');
  t('提交后可撤销', h.status().canUndo === true);
  t('撤销返回上一步', h.undo().v === 1);
  t('重做返回下一步', h.redo().v === 2);
  t('撤销到栈底后不可再撤销', (() => { h.undo(); h.undo(); return h.status().canUndo === false; })());
  t('重做链完整', h.status().canRedo === true);

  // 新提交截断未来
  h.commit({ v: 9 }, 'C');
  t('新提交后不可重做', h.status().canRedo === false);

  // 合并同标签
  const h2 = new History({ limit: 10, mergeMs: 100000 });
  h2.reset({ v: 0 });
  for (let i = 1; i <= 10; i++) h2.commit({ v: i }, '拖动', true);
  t('同标签连续提交合并为 1 条', h2.status().size === 2, `实际 ${h2.status().size}`);
  h2.seal();
  h2.commit({ v: 99 }, '拖动', true);
  t('seal 后不再合并', h2.status().size === 3);

  // 上限裁剪
  const h3 = new History({ limit: 3, mergeMs: 0 });
  h3.reset({ v: 0 });
  for (let i = 1; i <= 6; i++) h3.commit({ v: i }, 'X' + i);
  t('超出上限自动裁剪', h3.status().size === 3, `实际 ${h3.status().size}`);

  // 深拷贝隔离
  const h4 = new History({ limit: 5 });
  h4.reset({ nested: { a: 1 } });
  const snap = h4.current();
  snap.nested.a = 999;
  t('历史快照深拷贝隔离', h4.current().nested.a === 1);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
