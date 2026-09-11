import { chromium } from 'file:///C:/Users/廖先生/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const b = await chromium.launchPersistentContext('C://Users//Public//pw-render//piv-' + Date.now(), {
  headless: true, viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'], timeout: 90000,
});
const page = await b.newPage();
await page.goto('http://127.0.0.1:8848/index.html', { waitUntil: 'domcontentloaded' });
await page.setInputFiles('#file', path.join(ROOT, '_e2e', 'portrait2.jpg'));
await page.waitForFunction(() => {
  const cv = document.querySelector('#cvMain');
  return cv && cv.width > 0 && !document.querySelector('#ws').classList.contains('hidden');
}, { timeout: 45000 });
await page.waitForTimeout(1200);
await page.click('.tab[data-tab="angle"]');
await page.click('#btnAngle');
await page.click('#gridOn');
await page.click('#angleMode button[data-m="rotate"]');
await page.locator('.angle-range[data-key="rotate"]').evaluate((el)=>{
  el.value='15'; el.dispatchEvent(new Event('input',{bubbles:true}));
});
await page.click('#pivotMode button[data-p="custom"]');
const box = await page.locator('#cvMain').boundingBox();
// 从中心拖到偏左上
await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
await page.mouse.down();
await page.mouse.move(box.x + box.width*0.34, box.y + box.height*0.3, {steps: 12});
await page.mouse.up();
await page.waitForTimeout(400);
await page.locator('#cvMain').screenshot({ path: path.join(ROOT, '_e2e', 'shots', '06-轴心标记特写.png') });
await page.screenshot({ path: path.join(ROOT, '_e2e', 'shots', '07-轴心全页.png') });
const info = await page.evaluate(()=>{
  const el = document.querySelector('#cvMain');
  return { w: el.width, h: el.height };
});
console.log('canvas', JSON.stringify(info));
await b.close().catch(()=>{});
process.exit(0);
