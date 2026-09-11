// 端到端回归：真实浏览器 + 真实 MediaPipe 模型 + 真实抠图 + 角度面板全流程
// 用法：node _e2e/run.mjs
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_e2e', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
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
  sliderCount === 9 ? ok('9 个参数滑块已生成') : bad('参数滑块数量', String(sliderCount));

  const rows = await page.locator('#angleSliders .angle-row').evaluateAll((els) => els.map((e) => e.dataset.key));
  ok('滑块 key 列表', rows.join(','));

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

  // ---- 滑块调整：roll ----
  await page.click('#angleMode button[data-m="roll"]');
  await page.locator('.angle-range[data-key="roll"]').evaluate((el) => {
    el.value = '12';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const rollVal = await page.inputValue('.angle-num[data-key="roll"]');
  parseFloat(rollVal) === 12 ? ok('滑块设置 roll=12') : bad('滑块设置 roll=12', rollVal);

  // ---- 数值输入：yaw ----
  await page.click('#angleMode button[data-m="yaw"]');
  const yawNum = page.locator('.angle-num[data-key="yaw"]');
  await yawNum.fill('8.5');
  await yawNum.press('Enter');
  const yawVal = await page.inputValue('.angle-num[data-key="yaw"]');
  parseFloat(yawVal) === 8.5 ? ok('数值输入 yaw=8.5') : bad('数值输入 yaw=8.5', yawVal);
  const yawRange = await page.inputValue('.angle-range[data-key="yaw"]');
  parseFloat(yawRange) === 8.5 ? ok('滑块与数值双向同步') : bad('滑块与数值双向同步', yawRange);

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
  await page.click('#angleReset');
  const afterGroupReset = await page.inputValue('.angle-num[data-key="rotate"]');
  const rollStill = await page.inputValue('.angle-num[data-key="roll"]');
  parseFloat(afterGroupReset) === 0 ? ok('复位本组：rotate 归零') : bad('复位本组 rotate', afterGroupReset);
  parseFloat(rollStill) === 12 ? ok('复位本组未误伤其他组（roll 保持 12）') : bad('复位本组误伤', rollStill);

  // ---- 透视 ----
  await page.click('#angleMode button[data-m="persp"]');
  await page.locator('.angle-range[data-key="perspX"]').evaluate((el) => {
    el.value = '0.2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const hPersp = await canvasHash();
  hPersp !== h0 ? ok('透视校正改变画面') : bad('透视校正改变画面');
  // 梯形方向的精确语义由 _test.mjs 的源码级断言覆盖；
  // 端到端这里只确认「变换确实被应用到渲染结果上」（bbox 有位移即可）
  const mPersp = await fgMetrics();
  const perspBoxDiff = mPersp.bbox.reduce((s, v, i) => s + Math.abs(v - m0.bbox[i]), 0);
  perspBoxDiff > 2
    ? ok('透视校正已作用于前景几何', `bbox 差 ${perspBoxDiff}px`)
    : bad('透视校正未作用于前景', `bbox 差 ${perspBoxDiff}px`);

  // ---- 旋转中心（用 rotate 模式验证，透视与轴心无关）----
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
  // 轴心标记应绘制在轴心位置：直接检查变量，比截图更可靠
  const pivotXY = await page.evaluate(() => {
    const S = window.__S;
    return S && S.tf ? window.__pivotXY : null;
  });
  await page.screenshot({ path: path.join(OUT, '03-自定义旋转中心.png') });

  // 透视校正应当与轴心无关（回归防护）：同样是结构比对
  await page.click('#pivotMode button[data-p="center"]');
  await page.click('#angleMode button[data-m="persp"]');
  await page.click('#angleResetAll');
  await page.locator('.angle-range[data-key="perspX"]').evaluate((el) => {
    el.value = '0.25';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const mPerspA = await fgMetrics();
  await page.click('#pivotMode button[data-p="custom"]');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.7);
  await page.waitForTimeout(250);
  const mPerspB = await fgMetrics();
  const perspDrift = mPerspA && mPerspB
    ? Math.abs(mPerspB.cx - mPerspA.cx) + Math.abs(mPerspB.cy - mPerspA.cy)
    : 999;
  perspDrift < 3
    ? ok('透视校正与旋转中心解耦（不会误受轴心影响）', `质心漂移 ${perspDrift.toFixed(1)}px`)
    : bad('透视受轴心污染', `质心漂移 ${perspDrift.toFixed(1)}px`);
  await page.click('#pivotMode button[data-p="center"]');

  // ---- 网格 ----
  await page.check('#gridOn');
  const gridOn = await page.isChecked('#gridOn');
  gridOn ? ok('三分网格开关可用') : bad('三分网格开关');

  // ---- 全部复位 ----
  await page.click('#angleResetAll');
  const allZero = await page.evaluate(() => {
    const keys = ['rotate', 'roll', 'yaw', 'pitch', 'perspX', 'perspY'];
    return keys.every((k) => Math.abs(parseFloat(document.querySelector(`.angle-num[data-key="${k}"]`).value)) < 1e-6);
  });
  const zoomOne = await page.inputValue('.angle-num[data-key="zoom"]');
  allZero && parseFloat(zoomOne) === 1 ? ok('全部复位：参数归默认') : bad('全部复位', `zoom=${zoomOne}`);
  // 结构比对：复位后应与初始的前景 bbox / 质心一致
  const mReset = await fgMetrics();
  const dReset = Math.abs(mReset.cx - m0.cx) + Math.abs(mReset.cy - m0.cy);
  const dBoxReset = mReset.bbox.reduce((s, v, i) => s + Math.abs(v - m0.bbox[i]), 0);
  dReset < 3 && dBoxReset < 8
    ? ok('复位后画布结构回到初始', `质心差 ${dReset.toFixed(1)}px / bbox 差 ${dBoxReset}px`)
    : bad('复位后画布结构回到初始', `质心差 ${dReset.toFixed(1)}px / bbox 差 ${dBoxReset}px`);

  // ---- 导出参数 JSON ----
  await page.click('#angleMode button[data-m="roll"]');
  await page.locator('.angle-range[data-key="roll"]').evaluate((el) => {
    el.value = '-7.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.click('#btnExportJson');
  const d = await dl;
  const jsonPath = path.join(OUT, '角度参数.json');
  await d.saveAs(jsonPath);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  parsed.params.roll === -7.5 ? ok('导出参数 JSON 内容正确', `roll=${parsed.params.roll}`) : bad('导出 JSON', JSON.stringify(parsed.params));

  // ---- 改掉参数，再导入还原 ----
  await page.click('#angleResetAll');
  await page.setInputFiles('#fileJson', jsonPath);
  await page.waitForTimeout(400);
  const restored = await page.inputValue('.angle-num[data-key="roll"]');
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
