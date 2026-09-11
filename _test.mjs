import {
  identity, multiply, mulVec, perspectiveFrom4, rotateDeg, scaleXY, translate, mirrorX,
  rotation3D, buildMatrix, isIdentityMatrix, defaultParams, isNeutral, ANGLE_PARAMS, ANGLE_FLAGS,
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

console.log('\n[3] 3D 旋转（仅俯仰）');
{
  // 无旋转时应为单位阵
  const R0 = rotation3D(0, 1.8);
  t('零角度 = 单位投影', near(R0[0], 1) && near(R0[4], 1) && near(R0[8], 1));

  // pitch 应产生近大远小：上下两侧被放大/缩小的程度不同
  const Rp = rotation3D(20, 1.8);
  const pU = mulVec(Rp, 0, -0.9);
  const pD = mulVec(Rp, 0, 0.9);
  t('pitch 产生上下近大远小', Math.abs(pU.y) !== Math.abs(pD.y), `${pU.y.toFixed(3)} / ${pD.y.toFixed(3)}`);

  // pitch 保持原点不动
  const c = mulVec(Rp, 0, 0);
  t('pitch 保持中心不动', near(c.x, 0, 1e-9) && near(c.y, 0, 1e-9));

  // pitch 不应产生左右不对称（水平方向不受俯仰影响）
  const l = mulVec(Rp, -0.9, 0);
  const r = mulVec(Rp, 0.9, 0);
  t('pitch 不产生左右不对称', near(Math.abs(l.x), Math.abs(r.x), 1e-9), `左 ${l.x.toFixed(3)} 右 ${r.x.toFixed(3)}`);

  // 对称性：pitch +20 与 -20 应上下镜像
  const Rn = rotation3D(-20, 1.8);
  const pUn = mulVec(Rn, 0, -0.9);
  const pDn = mulVec(Rn, 0, 0.9);
  t('pitch 正负对称（上下镜像）', near(pU.y, -pDn.y, 1e-9) && near(pD.y, -pUn.y, 1e-9),
    `+20: ${pU.y.toFixed(3)}/${pD.y.toFixed(3)}  -20: ${pUn.y.toFixed(3)}/${pDn.y.toFixed(3)}`);
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
  // 注意：distort 是渲染阶段的逐像素径向函数、fov 只在 3D 旋转（pitch≠0）时
  // 才进入矩阵链，两者都不该在「中性 params」下改变矩阵本身。
  {
    const pp = { ...p0, pitch: 10 };
    const Mp = buildMatrix(pp, 295, 413, 1200, 1600);
    let d = 0;
    for (let i = 0; i < 9; i++) d += Math.abs(Mp[i] - M0[i]);
    t('pitch 参数生效', d > 1e-6, `diff=${d.toExponential(2)}`);
  }
  {
    const Mp = buildMatrix({ ...p0, distort: 0.1 }, 295, 413, 1200, 1600);
    let d = 0;
    for (let i = 0; i < 9; i++) d += Math.abs(Mp[i] - M0[i]);
    t('distort 不改变矩阵（走渲染阶段径向函数）', d < 1e-9, `diff=${d.toExponential(2)}`);
  }
  {
    // pitch=0 时 fov 无关；pitch≠0 时 fov 必须改变投影强度
    const a = buildMatrix({ ...p0, pitch: 15, fov: 1.0 }, 295, 413, 1200, 1600);
    const b = buildMatrix({ ...p0, pitch: 15, fov: 3.0 }, 295, 413, 1200, 1600);
    let d = 0;
    for (let i = 0; i < 9; i++) d += Math.abs(a[i] - b[i]);
    t('fov 在 3D 旋转生效时改变投影', d > 1e-6, `diff=${d.toExponential(2)}`);
  }

  // zoom
  const pz = { ...p0, zoom: 1.5 };
  const Mz = buildMatrix(pz, 295, 413, 1200, 1600);
  let dz = 0;
  for (let i = 0; i < 9; i++) dz += Math.abs(Mz[i] - M0[i]);
  t('zoom 参数生效', dz > 1e-6);

  // 已移除的参数不应再影响矩阵
  for (const key of ['roll', 'yaw', 'perspX', 'perspY']) {
    const pp = { ...p0, [key]: key.startsWith('persp') ? 0.3 : 20 };
    const Mp = buildMatrix(pp, 295, 413, 1200, 1600);
    let d = 0;
    for (let i = 0; i < 9; i++) d += Math.abs(Mp[i] - M0[i]);
    t(`${key} 已移除，不再影响矩阵`, d < 1e-9, `diff=${d.toExponential(2)}`);
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
  t('包含全部可调参数（5 项）', keys.length === 5, keys.join(','));
  t('已移除 roll / yaw / perspX / perspY',
    !keys.includes('roll') && !keys.includes('yaw') && !keys.includes('perspX') && !keys.includes('perspY'),
    keys.join(','));
  t('范围均有效（min<max, step>0）', ANGLE_PARAMS.every((p) => p.min < p.max && p.step > 0 && p.def >= p.min && p.def <= p.max));
  t('自由旋转范围 ±90°', ANGLE_PARAMS.find((p) => p.key === 'rotate').max === 90 && ANGLE_PARAMS.find((p) => p.key === 'rotate').min === -90);
  t('俯仰范围 ±25°', ANGLE_PARAMS.find((p) => p.key === 'pitch').max === 25);
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

console.log('\n[6d] 镜像（左右翻转）');
{
  const P = defaultParams();
  const ow = 200, oh = 300;

  // 默认未开启
  t('默认 mirror = false', P.mirror === false);
  t('默认参数判定为中性（含 mirror=false）', isNeutral(P));
  t('mirror=true 时非中性', !isNeutral({ ...P, mirror: true }));

  // 镜像矩阵本身：沿过画布中心的竖直线翻面，x → ow - x，y 不变
  const m = mirrorX(ow / 2);
  const a = mulVec(m, 0, 50);
  const b = mulVec(m, ow, 50);
  t('镜像把左边界映射到右边界', near(a.x, ow, 1e-9) && near(b.x, 0, 1e-9), `${a.x}, ${b.x}`);
  t('镜像不改变 y', near(a.y, 50, 1e-9) && near(b.y, 50, 1e-9));
  // 中心点不动
  const c = mulVec(m, ow / 2, oh / 2);
  t('镜像保持画布中心不动', near(c.x, ow / 2, 1e-9) && near(c.y, oh / 2, 1e-9));
  // 对合性：翻转两次 = 恒等
  const m2 = multiply(m, m);
  t('镜像是对合的（翻两次回到原位）', isIdentityMatrix(m2));

  // buildMatrix 中的行为
  const M0 = buildMatrix(P, ow, oh, ow, oh);
  const Mm = buildMatrix({ ...P, mirror: true }, ow, oh, ow, oh);
  let d = 0;
  for (let i = 0; i < 9; i++) d += Math.abs(Mm[i] - M0[i]);
  t('mirror 参数生效（矩阵改变）', d > 1e-6, `diff=${d.toFixed(3)}`);

  // 镜像「先于」旋转：先翻照片再转，而不是转完再翻
  //
  //   验证方法：取一个左右不对称的点。在「先镜像后旋转」语义下，
  //   输出左上角(0,0) 取样到的源点，应该等于「未镜像时输出右上角(ow,0)」取样点的镜像位置。
  const Mrot = buildMatrix({ ...P, rotate: 30 }, ow, oh, ow, oh);
  const MrotM = buildMatrix({ ...P, rotate: 30, mirror: true }, ow, oh, ow, oh);
  const pTL_rot = mulVec(Mrot, 0, 0);
  const pTR_rotM = mulVec(MrotM, ow, 0);
  t('镜像先于旋转生效（左上↔右上取样对应）',
    Math.abs(pTL_rot.x - pTR_rotM.x) < 1e-6 && Math.abs(pTL_rot.y - pTR_rotM.y) < 1e-6,
    `未镜像左上 ${pTL_rot.x.toFixed(2)},${pTL_rot.y.toFixed(2)} / 镜像后右上 ${pTR_rotM.x.toFixed(2)},${pTR_rotM.y.toFixed(2)}`);

  // 镜像不应受 pivot 影响（它翻的是照片本身，轴向恒定在画布中心）
  const Mp1 = buildMatrix({ ...P, mirror: true }, ow, oh, ow, oh, { x: 0, y: 0 });
  const Mp2 = buildMatrix({ ...P, mirror: true }, ow, oh, ow, oh, { x: ow, y: oh });
  let dp = 0;
  for (let i = 0; i < 9; i++) dp += Math.abs(Mp1[i] - Mp2[i]);
  t('镜像轴向不受旋转中心影响', dp < 1e-9, `diff=${dp.toExponential(2)}`);
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
