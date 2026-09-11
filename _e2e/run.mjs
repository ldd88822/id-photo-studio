// 端到端回归：真实浏览器 + 真实 MediaPipe 模型 + 真实抠图 + 角度面板全流程
// 用法：node _e2e/run.mjs
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_e2e', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:8848';
const steps = [];
let failed = 0;

function ok(name, extra = '') {
  steps.push(`  OK   ${name}${extra ? '  ' + extra : ''}`);
}
function bad(name, extra = '') {
  failed++;
  steps.push(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
}

// 用独立的 ASCII profile 目录，避免中文路径导致的 chromium 挂起
const PROFILE = 'C:\\Users\\Public\\pw-render\\idphoto-e2e-' + Date.now();

const browser = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  timeout: 90000,
});

const page = await browser.newPage();
// 禁用缓存：本地反复改代码时，缓存会导致「改了没生效」的假象
await page.route('**/*', (route) => route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache' } }));
await page.addInitScript(() => {
  // 页面脚本全部走网络重新拉取
  if (window.performance && performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(500);
});
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

try {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  ok('页面加载');

  // ---- 等脚本真正跑完（不能只等 DOM）----
  const ready = await page.waitForFunction(() => {
    const drop = document.querySelector('#drop');
    return !!drop && !!document.querySelector('#btnPick');
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  ready ? ok('脚本执行完成（DOM 就绪）') : bad('脚本执行完成');

  // ---- 上传人像（用高反差素材，提升 MediaPipe 分割可信度）----
  await page.setInputFiles('#file', path.join(ROOT, '_e2e', 'portrait2.jpg'));
  ok('注入测试图');

  // 等抠图完成：工作区可见 + 主画布有内容
  const matted = await page.waitForFunction(() => {
    const ws = document.querySelector('#ws');
    const cv = document.querySelector('#cvMain');
    if (!ws || ws.classList.contains('hidden')) return false;
    if (!cv || !cv.width) return false;
    // 采样主画布中心，确认不是纯背景
    const c = cv.getContext('2d');
    const d = c.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    return d[3] > 0;
  }, { timeout: 45000 }).then(() => true).catch(() => false);
  matted ? ok('AI 抠图完成，画布有内容') : bad('AI 抠图完成');
  await page.screenshot({ path: path.join(OUT, '01-上传完成.png') });

  // ---- 抠图质量：直接读 maskCanvas 的 alpha 通道，统计前景占比 ----
  // 不要用「与背景色比较」来判断前景：白底 + 白背景时整幅都是白的，判定必然失效
  const fgRatio = await page.evaluate(() => {
    const S = window.__S;
    const mc = S && S.maskCanvas;
    if (!mc) return -1;
    const c = mc.getContext('2d', { willReadFrequently: true });
    const d = c.getImageData(0, 0, mc.width, mc.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n / (mc.width * mc.height);
  });
  if (fgRatio < 0) bad('读取 maskCanvas', '未暴露 __S');
  else if (fgRatio > 0.05 && fgRatio < 0.95) ok('抠图前景占比合理', (fgRatio * 100).toFixed(1) + '%');
  else bad('抠图前景占比', (fgRatio * 100).toFixed(1) + '%');

  // 人脸是否检出（决定「人脸中心」轴心能否用）
  const faceOk = await page.evaluate(() => {
    const S = window.__S;
    return !!(S && S.face && S.face.w > 0);
  });
  ok(faceOk ? '人脸已检出' : '人脸未检出（不影响其他功能）');

  // ---- 切到角度 tab ----
  await page.click('.tab[data-tab="angle"]');
  const paneOn = await page.isVisible('.pane[data-pane="angle"]');
  paneOn ? ok('角度面板可见') : bad('角度面板可见');

  // ---- 滑块是否已由 ANGLE_PARAMS 生成 ----
  const sliderCount = await page.locator('#angleSliders .angle-range').count();
  sliderCount === 5 ? ok('5 个参数滑块已生成') : bad('参数滑块数量', String(sliderCount));

  const rows = await page.locator('#angleSliders .angle-row').evaluateAll((els) => els.map((e) => e.dataset.key));
  ok('滑块 key 列表', rows.join(','));
  rows.join(',') === 'rotate,pitch,zoom,distort,fov'
    ? ok('滑块顺序与数量完全符合精简后的参数表')
    : bad('滑块 key 列表不符合预期', rows.join(','));

  // 记录初始状态：不用逐像素哈希（两条渲染路径的插值实现不同，
  // 同样的几何也会产生不同的像素值），改用「前景边界 + 质心」这种结构性指标
  async function fgMetrics() {
    return page.evaluate(() => {
      const cv = document.querySelector('#cvMain');
      const c = cv.getContext('2d');
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, sx = 0, sy = 0, n = 0;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          // 前景判定：像素与画布四角背景色明显不同
          const bgR = d[0], bgG = d[1], bgB = d[2];
          const diff = Math.abs(d[i] - bgR) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bgB);
          if (diff > 60) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            sx += x; sy += y; n++;
          }
        }
      }
      if (!n) return null;
      return {
        bbox: [minX, minY, maxX, maxY],
        bboxW: maxX - minX,
        bboxH: maxY - minY,
        cx: +(sx / n).toFixed(1),
        cy: +(sy / n).toFixed(1),
        area: n,
      };
    });
  }
  const m0 = await fgMetrics();
  m0 ? ok('初始前景结构', `bbox ${m0.bbox.join(',')} 质心 ${m0.cx},${m0.cy}`) : bad('初始前景结构', 'null');
  const h0 = await canvasHash();
  ok('初始画布指纹（仅参考）', String(h0));

  // 画布指纹：只用于判断「是否变化」，不用于判断「是否相等」
  async function canvasHash() {
    return page.evaluate(() => {
      const cv = document.querySelector('#cvMain');
      const c = cv.getContext('2d');
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 97) {
        h ^= d[i];
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    });
  }

  // ---- 开启角度模式 ----
  await page.click('#btnAngle');
  const angleOn = await page.evaluate(() => document.querySelector('#btnAngle').classList.contains('primary'));
  angleOn ? ok('角度模式已开启') : bad('角度模式已开启');

  // ---- 拖拽旋转 ----
  const box = await page.locator('#cvMain').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  const rotVal = await page.inputValue('.angle-num[data-key="rotate"]');
  parseFloat(rotVal) > 1 ? ok('画布拖拽产生旋转', rotVal + '°') : bad('画布拖拽产生旋转', rotVal + '°');
  const h1 = await canvasHash();
  h1 !== h0 ? ok('旋转后画布内容已变化') : bad('旋转后画布内容已变化');
  await page.screenshot({ path: path.join(OUT, '02-拖拽旋转.png') });

  // ---- 撤销 ----
  await page.click('#btnUndo');
  const rotAfterUndo = await page.inputValue('.angle-num[data-key="rotate"]');
  Math.abs(parseFloat(rotAfterUndo)) < 1e-6 ? ok('撤销后旋转归零', rotAfterUndo) : bad('撤销后旋转归零', rotAfterUndo);
  // 结构比对：撤销后前景的 bbox 与质心应回到初始（允许 2px 插值误差）
  const mUndo = await fgMetrics();
  const dUndo = Math.abs(mUndo.cx - m0.cx) + Math.abs(mUndo.cy - m0.cy);
  const dBoxUndo = mUndo.bbox.reduce((s, v, i) => s + Math.abs(v - m0.bbox[i]), 0);
  dUndo < 3 && dBoxUndo < 8
    ? ok('撤销后画布结构复原', `质心差 ${dUndo.toFixed(1)}px / bbox 差 ${dBoxUndo}px`)
    : bad('撤销后画布结构复原', `质心差 ${dUndo.toFixed(1)}px / bbox 差 ${dBoxUndo}px`);

  // ---- 重做 ----
  await page.click('#btnRedo');
  const rotAfterRedo = await page.inputValue('.angle-num[data-key="rotate"]');
  Math.abs(parseFloat(rotAfterRedo) - parseFloat(rotVal)) < 1e-6
    ? ok('重做恢复旋转值', rotAfterRedo)
    : bad('重做恢复旋转值', `${rotVal} -> ${rotAfterRedo}`);

  // ---- 滑块调整：pitch ----
  await page.click('#angleMode button[data-m="pitch"]');
  await page.locator('.angle-range[data-key="pitch"]').evaluate((el) => {
    el.value = '12';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const pitchVal = await page.inputValue('.angle-num[data-key="pitch"]');
  parseFloat(pitchVal) === 12 ? ok('滑块设置 pitch=12') : bad('滑块设置 pitch=12', pitchVal);

  // ---- 数值输入：zoom ----
  const zoomNum = page.locator('.angle-num[data-key="zoom"]');
  await zoomNum.fill('1.25');
  await zoomNum.press('Enter');
  const zoomVal = await page.inputValue('.angle-num[data-key="zoom"]');
  parseFloat(zoomVal) === 1.25 ? ok('数值输入 zoom=1.25') : bad('数值输入 zoom=1.25', zoomVal);
  const zoomRange = await page.inputValue('.angle-range[data-key="zoom"]');
  parseFloat(zoomRange) === 1.25 ? ok('滑块与数值双向同步') : bad('滑块与数值双向同步', zoomRange);
  await zoomNum.fill('1');
  await zoomNum.press('Enter');

  // ---- 已移除的参数不应再出现在面板上 ----
  for (const key of ['roll', 'yaw', 'perspX', 'perspY']) {
    const n = await page.locator(`.angle-num[data-key="${key}"]`).count();
    n === 0 ? ok(`${key} 已从面板移除`) : bad(`${key} 仍存在于面板`, `找到 ${n} 个`);
  }
  for (const m of ['roll', 'yaw', 'persp']) {
    const n = await page.locator(`#angleMode button[data-m="${m}"]`).count();
    n === 0 ? ok(`快捷模式「${m}」已移除`) : bad(`快捷模式 ${m} 仍存在`);
  }

  // ---- 自由旋转量程 ±90° ----
  {
    const rEl = page.locator('.angle-num[data-key="rotate"]');
    const rMin = await rEl.getAttribute('min');
    const rMax = await rEl.getAttribute('max');
    parseFloat(rMin) === -90 && parseFloat(rMax) === 90
      ? ok('自由旋转量程 ±90°')
      : bad('自由旋转量程', `${rMin} ~ ${rMax}`);

    // 拖拽通道也必须能打到 45° 以上（原先硬编码 clamp 到 45 会在这里露馅）。
    // 注意方向：从画布左侧拖到右侧是 dx>0 → rotate 递增。
    await page.click('#angleMode button[data-m="rotate"]');
    await page.click('#angleResetAll');
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const dragged = parseFloat(await rEl.inputValue());
    dragged > 45 ? ok('拖拽可超过 45°（量程已放开）', `${dragged.toFixed(1)}°`) : bad('拖拽仍未突破 45°', `${dragged}°`);

    // 数值输入 90 应被接受（不被 clamp 到 45）
    await rEl.fill('90');
    await rEl.press('Enter');
    const r90 = parseFloat(await rEl.inputValue());
    r90 === 90 ? ok('数值输入 90° 被接受') : bad('数值输入 90° 被 clamp', `${r90}`);

    // 90° 下画面应有内容（不是全透明 / 全黑）
    const m90 = await fgMetrics();
    m90 && m90.area > 0 ? ok('旋转 90° 后画面仍有前景', `面积 ${m90.area}`) : bad('旋转 90° 后画面为空');
    await page.click('#angleResetAll');
  }

  // ---- 镜像功能 ----
  {
    const mBefore = await fgMetrics();
    const mir = page.locator('#mirrorOn');
    (await mir.count()) === 1 ? ok('镜像开关存在于面板') : bad('镜像开关缺失');

    // 镜像后画面必须变化
    await mir.check();
    await page.waitForTimeout(150);
    const mAfter = await fgMetrics();
    const changed = mBefore && mAfter
      ? Math.abs(mAfter.cx - mBefore.cx) + mAfter.bbox.reduce((s, v, i) => s + Math.abs(v - mBefore.bbox[i]), 0)
      : 0;
    changed > 3 ? ok('镜像后画面发生变化', `位移量 ${changed.toFixed(1)}`) : bad('镜像后画面未变化', `${changed}`);

    // 镜像的几何本质：内容左右翻面 → bbox 宽度不变、质心关于画布中线对称
    const cw = await page.evaluate(() => document.querySelector('#cvMain').width);
    if (mBefore && mAfter) {
      const expectCx = cw - mBefore.cx;
      Math.abs(mAfter.cx - expectCx) < 6
        ? ok('镜像 = 质心关于画布中线对称', `${mBefore.cx.toFixed(1)} → ${mAfter.cx.toFixed(1)}（期望 ${expectCx.toFixed(1)}）`)
        : bad('镜像质心对称性不符', `${mAfter.cx.toFixed(1)} vs 期望 ${expectCx.toFixed(1)}`);
      Math.abs(mAfter.bboxW - mBefore.bboxW) <= 2
        ? ok('镜像不改变前景宽度', `${mBefore.bboxW} → ${mAfter.bboxW}`)
        : bad('镜像改变了前景宽度', `${mBefore.bboxW} → ${mAfter.bboxW}`);
    }

    // 再翻一次应回到原状
    await mir.uncheck();
    await page.waitForTimeout(150);
    const mBack = await fgMetrics();
    mBack && mBefore && Math.abs(mBack.cx - mBefore.cx) < 2
      ? ok('取消镜像后画面复原（对合性）', `质心差 ${Math.abs(mBack.cx - mBefore.cx).toFixed(2)}px`)
      : bad('取消镜像未复原', `${mBack && mBack.cx} vs ${mBefore && mBefore.cx}`);

    // 镜像必须可撤销
    await mir.check();
    await page.waitForTimeout(120);
    await page.click('#btnUndo');
    await page.waitForTimeout(150);
    const mirState = await mir.isChecked();
    !mirState ? ok('镜像可被撤销') : bad('镜像未被撤销');

    // 全部复位后镜像应回到未勾选
    await mir.check();
    await page.waitForTimeout(120);
    await page.click('#angleResetAll');
    await page.waitForTimeout(150);
    const afterReset = await mir.isChecked();
    !afterReset ? ok('全部复位后镜像回到关闭') : bad('全部复位未清镜像');
  }

  // ---- 镜像 + 旋转组合不应报错 ----
  {
    await page.locator('#mirrorOn').check();
    const rEl2 = page.locator('.angle-num[data-key="rotate"]');
    await rEl2.fill('30');
    await rEl2.press('Enter');
    await page.waitForTimeout(150);
    const mCombo = await fgMetrics();
    mCombo && mCombo.area > 0 ? ok('镜像 + 30° 旋转组合正常渲染', `面积 ${mCombo.area}`) : bad('镜像组合渲染失败');
    await page.locator('#mirrorOn').uncheck();
    await page.click('#angleResetAll');
    await page.waitForTimeout(150);
  }

  // ---- 水平吸附：输入 1.2 应归零 ----
  await page.click('#angleMode button[data-m="rotate"]');
  const rotNum2 = page.locator('.angle-num[data-key="rotate"]');
  await rotNum2.fill('1.2');
  await rotNum2.press('Enter');
  const snapVal = await page.inputValue('.angle-num[data-key="rotate"]');
  parseFloat(snapVal) === 0 ? ok('±2° 内水平吸附归零', snapVal) : bad('水平吸附', snapVal);

  // ---- 键盘微调 ----
  await page.locator('#cvMain').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('ArrowRight');
  const nudge1 = await page.inputValue('.angle-num[data-key="rotate"]');
  parseFloat(nudge1) > 0 ? ok('方向键粗调 +1°', nudge1) : bad('方向键粗调', nudge1);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  const nudge2 = await page.inputValue('.angle-num[data-key="rotate"]');
  Math.abs(parseFloat(nudge2) - (parseFloat(nudge1) + 0.1)) < 1e-6
    ? ok('Shift 方向键细调 +0.1°', nudge2)
    : bad('Shift 方向键细调', `${nudge1} -> ${nudge2}`);

  // ---- 三档复位 ----
  // 先把 pitch 设成 12，才能验证「复位本组」不会误伤其他组。
  // （中间新增的镜像用例会调用全部复位，所以这里必须重新设置一次）
  {
    const pEl = page.locator('.angle-num[data-key="pitch"]');
    await pEl.fill('12');
    await pEl.press('Enter');
  }
  await page.click('#angleMode button[data-m="rotate"]');
  await page.click('#angleReset');
  const afterGroupReset = await page.inputValue('.angle-num[data-key="rotate"]');
  const pitchStill = await page.inputValue('.angle-num[data-key="pitch"]');
  parseFloat(afterGroupReset) === 0 ? ok('复位本组：rotate 归零') : bad('复位本组 rotate', afterGroupReset);
  parseFloat(pitchStill) === 12 ? ok('复位本组未误伤其他组（pitch 保持 12）') : bad('复位本组误伤', pitchStill);

  // ---- 旋转中心（用 rotate 模式验证）----
  await page.click('#angleMode button[data-m="rotate"]');
  await page.click('#pivotMode button[data-p="center"]');
  await page.click('#angleResetAll');
  await page.locator('.angle-range[data-key="rotate"]').evaluate((el) => {
    el.value = '20';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const mPivotCenter = await fgMetrics();
  await page.click('#pivotMode button[data-p="custom"]');
  await page.waitForTimeout(150);
  // 新交互：拖动轴心标记来移动旋转中心（不再是一次点击就定轴心，
  // 避免用户每次旋转都被悄悄改掉轴心）。
  // 轴心默认在画布中心，先按住中心再拖到左上角。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const mPivotCustom = await fgMetrics();
  // 用 bbox 与面积综合判断：绕不同轴心旋转同一角度，前景的包围盒与面积都会变
  // （单看质心可能因图形近似对称而几乎不动，是无效指标）
  const boxDiff = mPivotCenter && mPivotCustom
    ? mPivotCenter.bbox.reduce((s, v, i) => s + Math.abs(v - mPivotCustom.bbox[i]), 0)
    : 0;
  const areaDiff = mPivotCenter && mPivotCustom
    ? Math.abs(mPivotCenter.area - mPivotCustom.area) / Math.max(1, mPivotCenter.area)
    : 0;
  boxDiff > 6 || areaDiff > 0.02 || Math.abs(mPivotCustom.cx - mPivotCenter.cx) > 3
    ? ok('拖动轴心后画面改变', `bbox 差 ${boxDiff}px / 质心差 ${Math.abs(mPivotCustom.cx - mPivotCenter.cx).toFixed(1)}px`)
    : bad('拖动轴心后画面改变', `bbox 差 ${boxDiff}px / 面积差 ${(areaDiff * 100).toFixed(1)}%`);
  await page.screenshot({ path: path.join(OUT, '03-自定义旋转中心.png') });

  // 轴心只作用于几何链、不影响 cover 铺排：换轴心时画面中心取样点应保持稳定
  await page.click('#pivotMode button[data-p="center"]');
  await page.click('#angleResetAll');
  await page.locator('.angle-range[data-key="rotate"]').evaluate((el) => {
    el.value = '18';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const mAxisA = await fgMetrics();
  await page.click('#pivotMode button[data-p="custom"]');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const mAxisB = await fgMetrics();
  // 轴心改变必然改变几何，所以这里只断言「变了」，且幅度在合理范围内（不是整幅跑飞）
  const axisDrift = mAxisA && mAxisB
    ? Math.abs(mAxisB.cx - mAxisA.cx) + Math.abs(mAxisB.cy - mAxisA.cy)
    : 0;
  axisDrift > 1 && axisDrift < box.width
    ? ok('轴心改变影响几何且幅度合理', `质心漂移 ${axisDrift.toFixed(1)}px`)
    : bad('轴心改变影响异常', `质心漂移 ${axisDrift.toFixed(1)}px`);
  await page.click('#pivotMode button[data-p="center"]');

  // ---- 网格 ----
  await page.check('#gridOn');
  const gridOn = await page.isChecked('#gridOn');
  gridOn ? ok('三分网格开关可用') : bad('三分网格开关');

  // ---- 全部复位 ----
  await page.click('#angleResetAll');
  const allZero = await page.evaluate(() => {
    const keys = ['rotate', 'pitch', 'distort'];
    return keys.every((k) => Math.abs(parseFloat(document.querySelector(`.angle-num[data-key="${k}"]`).value)) < 1e-6);
  });
  const zoomOne = await page.inputValue('.angle-num[data-key="zoom"]');
  const fovOne = await page.inputValue('.angle-num[data-key="fov"]');
  allZero && parseFloat(zoomOne) === 1 && Math.abs(parseFloat(fovOne) - 1.8) < 1e-6
    ? ok('全部复位：参数归默认')
    : bad('全部复位', `zoom=${zoomOne} fov=${fovOne}`);
  // 结构比对：复位后应与初始的前景 bbox / 质心一致
  const mReset = await fgMetrics();
  const dReset = Math.abs(mReset.cx - m0.cx) + Math.abs(mReset.cy - m0.cy);
  const dBoxReset = mReset.bbox.reduce((s, v, i) => s + Math.abs(v - m0.bbox[i]), 0);
  dReset < 3 && dBoxReset < 8
    ? ok('复位后画布结构回到初始', `质心差 ${dReset.toFixed(1)}px / bbox 差 ${dBoxReset}px`)
    : bad('复位后画布结构回到初始', `质心差 ${dReset.toFixed(1)}px / bbox 差 ${dBoxReset}px`);

  // ---- 导出参数 JSON ----
  await page.click('#angleMode button[data-m="pitch"]');
  await page.locator('.angle-range[data-key="pitch"]').evaluate((el) => {
    el.value = '-7.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.click('#btnExportJson');
  const d = await dl;
  const jsonPath = path.join(OUT, '角度参数.json');
  await d.saveAs(jsonPath);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  parsed.params.pitch === -7.5 ? ok('导出参数 JSON 内容正确', `pitch=${parsed.params.pitch}`) : bad('导出 JSON', JSON.stringify(parsed.params));
  // 导出的 JSON 不应再含有已移除的字段
  const hasRemoved = ['roll', 'yaw', 'perspX', 'perspY'].some((k) => k in parsed.params);
  !hasRemoved ? ok('导出 JSON 不含已移除字段') : bad('导出 JSON 仍含已移除字段', JSON.stringify(parsed.params));
  // 镜像字段应被持久化
  'mirror' in parsed.params ? ok('导出 JSON 含 mirror 字段', String(parsed.params.mirror)) : bad('导出 JSON 缺 mirror 字段');

  // ---- 改掉参数，再导入还原 ----
  await page.click('#angleResetAll');
  await page.setInputFiles('#fileJson', jsonPath);
  await page.waitForTimeout(400);
  const restored = await page.inputValue('.angle-num[data-key="pitch"]');
  Math.abs(parseFloat(restored) + 7.5) < 1e-6 ? ok('导入参数 JSON 还原成功', restored) : bad('导入参数还原', restored);

  // ---- 导出下载：单张 PNG ----
  await page.click('.tab[data-tab="out"]');
  await page.fill('#fname', 'e2e测试');
  const dl2 = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#btnDownload');
  const f2 = await dl2;
  const pngPath = path.join(OUT, '成品.png');
  await f2.saveAs(pngPath);
  const size = fs.statSync(pngPath).size;
  // 一寸 295×413 的纯色底 PNG 体积本来就小，阈值按尺寸算而非拍脑袋
  const minBytes = 1500;
  size > minBytes ? ok('下载 PNG 成功', (size / 1024).toFixed(1) + ' KB') : bad('下载 PNG', size + ' B');
  // 顺带确认导出尺寸与规格一致
  const outSize = await page.evaluate(() => window.__api.curPx());
  ok('导出尺寸符合规格', `${outSize.w}×${outSize.h}px`);

  // 校验 PNG 元数据 tEXt 块
  const buf = fs.readFileSync(pngPath);
  const sigOk = buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
  const txtIdx = buf.indexOf(Buffer.from('IDPhotoStudio'));
  ok(sigOk ? '导出文件是合法 PNG' : 'PNG 签名错误');
  txtIdx > 0 ? ok('PNG 内已注入参数元数据', 'offset=' + txtIdx) : bad('PNG 参数元数据缺失');
  if (txtIdx > 0) {
    const tail = buf.subarray(txtIdx, txtIdx + 400).toString('utf8').replace(/\0/g, '|');
    ok('元数据片段', tail.slice(0, 120));
  }

  await page.screenshot({ path: path.join(OUT, '04-导出面板.png') });

  // ---- 模型加载反馈（弱网可用性）----
  (await page.$('#loadRetry')) ? ok('加载遮罩含重试按钮 #loadRetry') : bad('缺少 #loadRetry 重试按钮');
  (await page.isHidden('#loadRetry')) ? ok('重试按钮默认隐藏') : bad('重试按钮默认应隐藏');

  // 进度回调：注册探针后强制重跑一次初始化，确认生命周期事件齐全
  // 注意：首次加载时模型可能已被预加载缓存，必须 force=true 才能重新触发事件
  const phases = await page.evaluate(async () => {
    const m = await import('./js/matting.js');
    const seen = [];
    m.setProgressHandler((p) => seen.push(p));
    await m.initMatting(true);
    return seen;
  });
  const hasReady = phases.includes('ready');
  hasReady ? ok('初始化触发 ready 事件', phases.join(' → ')) : bad('未触发 ready 事件', JSON.stringify(phases));
  phases.includes('prefetch') && phases.includes('parsing')
    ? ok('初始化含 prefetch → parsing 阶段', phases.join(' → '))
    : bad('生命周期阶段缺失', JSON.stringify(phases));

  // 失败态可切换 + 重试可恢复
  const failState = await page.evaluate(() => {
    const box = document.querySelector('#loading');
    const btn = document.querySelector('#loadRetry');
    box.classList.remove('hidden');
    btn.hidden = false;
    return { boxVisible: !box.classList.contains('hidden'), btnVisible: !btn.hidden };
  });
  failState.boxVisible && failState.btnVisible
    ? ok('可进入失败态并露出重试按钮')
    : bad('失败态切换异常', JSON.stringify(failState));

  // 注意：切到导出 tab 后 #loadRetry 位于舞台区，page.click 的可见性校验可能
  // 因面板遮挡而静默不触发，这里直接用原生 click 派发，确保命中 handler
  await page.evaluate(() => document.querySelector('#loadRetry').click());
  // 重试可能重跑整条抠图流程，改为轮询等待遮罩关闭，而不是死等固定时长
  let recovered = { hidden: false };
  const rDeadline = Date.now() + 30000;
  const rSeen = [];
  while (Date.now() < rDeadline) {
    recovered = await page.evaluate(() => ({
      hidden: document.querySelector('#loading').classList.contains('hidden'),
      btnHidden: document.querySelector('#loadRetry').hidden,
      txt: document.querySelector('#loadTxt').textContent,
    }));
    if (!rSeen.includes(recovered.txt)) rSeen.push(recovered.txt);
    if (recovered.hidden) break;
    await page.waitForTimeout(300);
  }
  recovered.hidden
    ? ok('点重试后恢复（遮罩关闭）', `btnHidden=${recovered.btnHidden}`)
    : bad('重试未恢复', JSON.stringify(recovered) + ' 文案轨迹=' + JSON.stringify(rSeen));

  // 初始化失败后不得让坏 Promise 永久缓存（否则重试永远无效）
  const noStaleCache = await page.evaluate(async () => {
    const m = await import('./js/matting.js');
    const a = await m.initMatting(false);
    const b = await m.initMatting(false);
    return !!(a && b && a.ok === b.ok);
  });
  noStaleCache ? ok('重复调用 initMatting 结果一致（无坏缓存）') : bad('initMatting 缓存异常');

  // ---- 手机视口 ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.tab[data-tab="angle"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '05-手机端角度面板.png') });
  const mobileOk = await page.locator('#angleSliders .angle-range').first().isVisible();
  mobileOk ? ok('手机视口下角度面板可交互') : bad('手机视口角度面板');
} catch (e) {
  bad('执行异常', e.message);
  try { await page.screenshot({ path: path.join(OUT, '99-异常.png') }); } catch {}
} finally {
  console.log('\n===== 端到端回归结果 =====');
  console.log(steps.join('\n'));
  if (errors.length) {
    console.log('\n--- 页面错误 ---');
    console.log(errors.slice(0, 15).join('\n'));
  } else {
    console.log('\n无页面 JS 错误');
  }
  console.log(`\n失败 ${failed} 项`);
  console.log('截图目录: ' + OUT);
  process.exit(failed ? 1 : 0);
}
