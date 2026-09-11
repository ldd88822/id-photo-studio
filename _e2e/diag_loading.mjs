// 诊断：模型初始化卡住问题
// 真机复现「正在准备模型…」不返回的场景，记录每个阶段耗时与错误
import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';

const URL_BASE = process.env.IDP_URL || 'http://127.0.0.1:8848/';
const PROFILE = 'C:\\Users\\Public\\pw-diag-' + Date.now();

const t0 = Date.now();
const log = [];
const stamp = (m) => {
  const s = ((Date.now() - t0) / 1000).toFixed(2);
  const line = `[${s}s] ${m}`;
  log.push(line);
  console.log(line);
};

const run = async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);

  page.on('console', (m) => stamp(`CONSOLE ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => stamp(`PAGEERROR: ${e.message}`));
  page.on('requestfailed', (r) =>
    stamp(`REQFAIL: ${r.url().replace(URL_BASE, '')} :: ${r.failure()?.errorText}`)
  );
  // 监控 wasm / tflite 的实际字节进度
  page.on('response', async (r) => {
    const u = r.url();
    if (/\.(mjs|wasm|tflite)$/.test(u)) {
      const len = r.headers()['content-length'] || '?';
      stamp(`RESP ${r.status()} ${u.replace(URL_BASE, '')} len=${len}`);
    }
  });

  stamp('goto ' + URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  stamp('DOM ready');

  // 等 page 脚本自己写完成标志（避免误判，见历史踩坑）
  await page.waitForFunction(() => !!document.querySelector('#drop'), null, { timeout: 30000 });
  stamp('UI 就绪');

  // 注入探针：直接调用 initMatting 并计时
  stamp('--- 调用 initMatting() 计时 ---');
  const r = await page.evaluate(async () => {
    const t = performance.now();
    const mod = await import('./js/matting.js');
    const out = { steps: [] };
    out.steps.push(['import ok', performance.now() - t]);
    let res = null;
    let err = null;
    try {
      res = await Promise.race([
        mod.initMatting(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_30S')), 30000)),
      ]);
    } catch (e) {
      err = String(e && e.message);
    }
    out.steps.push(['initMatting done', performance.now() - t]);
    return { out, res, err };
  });
  stamp('initMatting 结果: ' + JSON.stringify(r.err || r.res));
  for (const [k, v] of r.out.steps) stamp(`  ${k}: ${v.toFixed(0)}ms`);

  // 再走一次真实上传流程
  stamp('--- 模拟上传真实图片 ---');
  const fileInput = await page.$('input[type=file]');
  if (fileInput) {
    await fileInput.setInputFiles('D:/AI/2026-09-04-18-58-59/idphoto/_e2e/portrait2.jpg');
    stamp('已设置文件');
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#loading');
          return el && el.classList.contains('hidden');
        },
        null,
        { timeout: 60000 }
      );
      stamp('✅ loading 已隐藏，流程走通');
    } catch (e) {
      const txt = await page.textContent('#loadTxt').catch(() => '?');
      const visible = await page.isVisible('#loading').catch(() => '?');
      stamp(`❌ 卡住！loadTxt="${txt}" loading可见=${visible}`);
    }
  } else {
    stamp('找不到 file input');
  }

  await page.screenshot({ path: 'D:/AI/2026-09-04-18-58-59/idphoto/_e2e/shots/diag.png' });
  stamp('截图完成');

  await ctx.close().catch(() => {});
  process.exit(0);
};

run().catch((e) => {
  console.error('DIAG FAIL:', e);
  process.exit(1);
});
