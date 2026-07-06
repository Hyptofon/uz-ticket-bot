const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Loading app.uz.gov.ua...');
  await page.goto('https://app.uz.gov.ua/', { waitUntil: 'networkidle' });
  
  console.log('Waiting 5s...');
  await page.waitForTimeout(5000);
  
  const storage = await page.evaluate(() => {
    return {
      local: { ...localStorage },
      session: { ...sessionStorage }
    };
  });

  console.log('Storage:', JSON.stringify(storage, null, 2));
  await browser.close();
})();
