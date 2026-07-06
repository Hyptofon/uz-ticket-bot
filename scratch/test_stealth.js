const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Launching stealth Chrome...');
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle' });
  console.log('Navigated. Waiting 5s...');
  await page.waitForTimeout(5000);
  
  const title = await page.title();
  console.log('Title:', title);
  
  await page.screenshot({ path: 'scratch/stealth_test.png' });
  console.log('Saved screenshot. Close browser manually.');
  await browser.close();
})();
