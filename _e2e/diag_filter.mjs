// 诊断：角度渲染路径是否丢失了亮度/对比度滤镜
// 思路：同一张图，分别用「不启用角度」和「启用角度(旋转0.01°)」渲染，
//      比较输出像素的对比度指标（标准差）与平均亮度。
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import path from 'node:path';

const URL_BASE = process.env.IDP_URL || 'http://127.0.0.1:8848/';
const profile = 'C:\\Users\\Public\\pw-filter-' + Date.now();

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#drop', { timeout: 60000 });
await page.setInputFiles('#file', path.join(import.meta.dirname, 'portrait2.jpg'));
await page.waitForFunction(
  () => {
    const l = document.querySelector('#loading');
    return l && l.classList.contains('hidden');
  },
  null,
  { timeout: 90000 }
);
await page.waitForTimeout(800);
console.log('上传完成');

// 统计工具：亮度均值/标准差 + 锐度（相邻像素梯度均值，越高越锐）
const statsOf = (sel) =>
  page.evaluate((s) => {
    const cv = document.querySelector(s);
    const c = cv.getContext('2d', { willReadFrequently: true });
    const w = cv.width;
    const h = cv.height;
    const d = c.getImageData(0, 0, w, h).data;
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let grad = 0;
    let gn = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 250) continue;
        const y1 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += y1;
        sum2 += y1 * y1;
        n++;
        // 与左侧和上方像素的亮度差，反映高频细节
        const il = (y * w + x - 1) * 4;
        const iu = ((y - 1) * w + x) * 4;
        if (d[il + 3] >= 250 && d[iu + 3] >= 250) {
          const yl = 0.299 * d[il] + 0.587 * d[il + 1] + 0.114 * d[il + 2];
          const yu = 0.299 * d[iu] + 0.587 * d[iu + 1] + 0.114 * d[iu + 2];
          grad += Math.abs(y1 - yl) + Math.abs(y1 - yu);
          gn++;
        }
      }
    }
    if (!n) return null;
    const mean = sum / n;
    return {
      n,
      mean: +mean.toFixed(2),
      sd: +Math.sqrt(sum2 / n - mean * mean).toFixed(2),
      sharp: gn ? +(grad / gn).toFixed(3) : 0,
    };
  }, sel);

// ---- 阶段 1：增强参数为默认，记录基准 ----
const base = await statsOf('#cvMain');
console.log('① 默认参数          ', JSON.stringify(base));

// ---- 阶段 2：把对比度拉高（不开角度）----
await page.click('.tab[data-tab="fix"]').catch(() => {});
await page.waitForTimeout(300);
const conSet = await page.evaluate(() => {
  const el = document.querySelector('#con');
  if (!el) return null;
  el.value = '140';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
});
await page.waitForTimeout(500);
console.log(`② 对比度设为 ${conSet}%（未启用角度）`);
const enhanced = await statsOf('#cvMain');
console.log('   像素统计          ', JSON.stringify(enhanced));
await page.screenshot({ path: path.join(import.meta.dirname, 'shots', 'filter_angle_off.png') });

// ---- 阶段 3：开启角度模式（必须点 #btnAngle，否则 isEnabled() 为 false）----
const turnedOn = await page.evaluate(() => {
  const b = document.querySelector('#btnAngle');
  if (!b) return null;
  b.click();
  return b.textContent.trim();
});
await page.waitForTimeout(600);
const afterEnable = await statsOf('#cvMain');
console.log(`③ 开启角度模式（按钮变为「${turnedOn}」）`, JSON.stringify(afterEnable));
await page.screenshot({ path: path.join(import.meta.dirname, 'shots', 'filter_angle_on.png') });

await page.locator('.angle-num[data-key="rotate"]').fill('0.5');
await page.locator('.angle-num[data-key="rotate"]').press('Enter');
await page.waitForTimeout(700);
const afterRot = await statsOf('#cvMain');
console.log('④ 旋转 0.5°（走 renderTransformed）', JSON.stringify(afterRot));

// ---- 结论 ----
console.log('\n===== 对比 =====');
const line = (label, a, b) => {
  if (!a || !b) {
    console.log(`${label}: 数据缺失`);
    return;
  }
  const dSd = +(b.sd - a.sd).toFixed(2);
  const pct = +((dSd / a.sd) * 100).toFixed(1);
  console.log(`${label}: sd ${a.sd} → ${b.sd}  (${dSd > 0 ? '+' : ''}${dSd}, ${pct}%)`);
};
line('默认 → 对比度140%     ', base, enhanced);
line('对比度140% → 开启角度 ', enhanced, afterEnable);
line('对比度140% → 旋转0.5° ', enhanced, afterRot);

// 锐度对比：未开角度走浏览器原生缩放，开角度走手写双线性采样
if (base && enhanced && afterRot) {
  console.log('\n锐度（相邻像素梯度均值，越高越锐）');
  console.log(`  未开角度（原生缩放）: ${enhanced.sharp}`);
  console.log(`  开角度（手写采样）  : ${afterRot.sharp}`);
  const d = +(((afterRot.sharp - enhanced.sharp) / enhanced.sharp) * 100).toFixed(1);
  console.log(`  差异: ${d > 0 ? '+' : ''}${d}%`);
  console.log('  若明显下降，说明手写双线性在缩小场景欠采样，需要加预滤波。');
}
console.log('\n滤镜结论：若「对比度140% → 开启角度」的 sd 保持不降，说明预烘焙修复生效。');

await ctx.close().catch(() => {});
process.exit(0);
