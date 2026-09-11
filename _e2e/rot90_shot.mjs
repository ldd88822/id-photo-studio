// 大角度旋转的实拍验证：截图 45° / 90° / 90°+镜像 三种状态
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

// 每次用全新 profile：固定 profile 会缓存旧版 JS，导致 ESM 导出不匹配（踩过）
const profile = 'C:\\Users\\Public\\pw-render\\rot90-' + Date.now();
const ctx = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await ctx.newPage();
page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto('http://127.0.0.1:8848/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#btnPick'), null, { timeout: 60000 });

// 注入测试人像（复用 e2e 的高反差素材）
await page.setInputFiles('#file', path.join(import.meta.dirname, 'portrait2.jpg'));

// 等抠图完成：工作区可见 + 主画布有内容（与 run.mjs 条件保持一致）
await page.waitForFunction(() => {
  const ws = document.querySelector('#ws');
  const cv = document.querySelector('#cvMain');
  if (!ws || ws.classList.contains('hidden')) return false;
  if (!cv || !cv.width) return false;
  const c = cv.getContext('2d');
  const d = c.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
  return d[3] > 0;
}, null, { timeout: 90000 });
await page.waitForTimeout(1200);

// 开启角度模式：切到右侧「角度」tab（#btnAngle 在步骤 3 才可见）
await page.click('.tab[data-tab="angle"]');
await page.waitForTimeout(500);

const setRot = async (deg) => {
  const el = page.locator('.angle-num[data-key="rotate"]');
  await el.fill(String(deg));
  await el.press('Enter');
  await page.waitForTimeout(350);
};

// 先看 90°，并测四角是否露白
const cornerCheck = async (label) => {
  const r = await page.evaluate(() => {
    const cv = document.querySelector('#cvMain');
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x, y) => {
      const i = (y * cv.width + x) * 4;
      return d[i + 3];
    };
    const w = cv.width, h = cv.height;
    return {
      w, h,
      tl: at(2, 2), tr: at(w - 3, 2), bl: at(2, h - 3), br: at(w - 3, h - 3),
    };
  });
  const allOpaque = r.tl === 255 && r.tr === 255 && r.bl === 255 && r.br === 255;
  console.log(label, '画布', r.w + 'x' + r.h, '四角 alpha:', r.tl, r.tr, r.bl, r.br, allOpaque ? '→ 满幅' : '→ 有透明角');
  return allOpaque;
};

await setRot(0);
await cornerCheck('rotate=0   ');
await setRot(45);
await cornerCheck('rotate=45  ');
await page.screenshot({ path: path.join(OUT, 'r45.png') });
await setRot(90);
await cornerCheck('rotate=90  ');
await page.screenshot({ path: path.join(OUT, 'r90.png') });

await page.locator('#mirrorOn').check();
await page.waitForTimeout(300);
await cornerCheck('rot90+mirror');
await page.screenshot({ path: path.join(OUT, 'r90m.png') });

console.log('截图已保存到', OUT);
process.exit(0);
