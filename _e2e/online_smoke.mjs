// 线上冒烟测试：真实网络下验证 v1.4
// 重点：1) 弱网进度提示是否真的出现 2) 功能是否可用
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import path from 'node:path';

const URL_BASE = 'https://ldd88822.github.io/id-photo-studio/';
const OUT = path.join(import.meta.dirname, 'shots');
const profile = 'C:\\Users\\Public\\pw-online-' + Date.now();

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const seen = new Set();

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`[${el()}] PAGEERROR: ${e.message}`));
page.on('requestfailed', (r) =>
  console.log(`[${el()}] REQFAIL: ${r.url().replace(URL_BASE, '')} :: ${r.failure()?.errorText}`)
);

console.log(`[${el()}] 打开线上站点…`);
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
// 注意：waitForSelector 是两参 (selector, options)，别照搬 waitForFunction 的三参写法
await page.waitForSelector('#drop', { timeout: 120000 });
console.log(`[${el()}] UI 就绪`);

// ---- 观察加载遮罩文案变化（验证进度提示真的在工作）----
console.log(`\n[${el()}] 上传图片，观察进度提示…`);
await page.setInputFiles('input[type=file]', path.join(import.meta.dirname, 'portrait2.jpg'));

const deadline = Date.now() + 300000;
let done = false;
while (Date.now() < deadline) {
  const st = await page.evaluate(() => {
    const l = document.querySelector('#loading');
    const t = document.querySelector('#loadTxt');
    return { hidden: l.classList.contains('hidden'), txt: t ? t.textContent : '' };
  });
  const key = st.txt.slice(0, 60);
  if (st.txt && !seen.has(key)) {
    seen.add(key);
    console.log(`  [${el()}] 「${st.txt.replace(/\n/g, ' / ')}」`);
  }
  if (st.hidden) {
    done = true;
    break;
  }
  await page.waitForTimeout(400);
}

if (done) {
  console.log(`[${el()}] ✅ 抠图完成，遮罩已关闭`);
} else {
  const txt = await page.textContent('#loadTxt').catch(() => '?');
  console.log(`[${el()}] ❌ 超时仍在加载: 「${txt}」`);
}

const hadPct = [...seen].some((s) => /\d+%/.test(s));
const hadSlowHint = [...seen].some((s) => /网络较慢/.test(s));
console.log(`  进度百分比出现: ${hadPct ? '是' : '否'}`);
console.log(`  慢速提示出现:   ${hadSlowHint ? '是' : '否'}`);

// ---- 角度面板：5 参数 + 镜像开关 ----
console.log(`\n[${el()}] 检查角度面板…`);
await page.click('.tab[data-tab="angle"]');
await page.waitForTimeout(600);
const panel = await page.evaluate(() => ({
  sliders: Array.from(document.querySelectorAll('.angle-range')).map((e) => e.dataset.key),
  nums: Array.from(document.querySelectorAll('.angle-num')).map((e) => e.dataset.key),
  mirror: !!document.querySelector('#mirrorOn'),
  quick: Array.from(document.querySelectorAll('#angleMode button')).map((b) => b.textContent.trim()),
}));
console.log('  滑杆:', panel.sliders.join(', '));
console.log('  快捷模式:', panel.quick.join(' / '));
console.log('  镜像开关存在:', panel.mirror ? '是' : '否');

const expectKeys = ['rotate', 'pitch', 'zoom', 'distort', 'fov'];
const keysOk = JSON.stringify(panel.sliders) === JSON.stringify(expectKeys);
console.log(`  参数表符合 v1.4 (${expectKeys.join(',')}): ${keysOk ? '是' : '否'}`);

// ---- 拉满 90° + 开镜像，截图 ----
console.log(`\n[${el()}] 测试 90° 旋转 + 镜像…`);
await page.locator('.angle-num[data-key="rotate"]').fill('90');
await page.locator('.angle-num[data-key="rotate"]').press('Enter');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'online_r90.png') });
console.log('  已截图 online_r90.png');

await page.check('#mirrorOn');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'online_r90_mirror.png') });
console.log('  已截图 online_r90_mirror.png');

const finalState = await page.evaluate(() => ({
  rotate: document.querySelector('.angle-num[data-key="rotate"]').value,
  mirror: document.querySelector('#mirrorOn').checked,
}));
console.log(`  最终状态: rotate=${finalState.rotate}° mirror=${finalState.mirror}`);

await ctx.close().catch(() => {});
console.log(`\n[${el()}] 冒烟测试结束`);
process.exit(0);
