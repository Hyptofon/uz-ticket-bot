const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('request', request => {
    if (request.url().includes('api/')) {
      console.log('->', request.method(), request.url(), request.headers());
    }
  });
  
  page.on('response', async response => {
    if (response.url().includes('api/')) {
      console.log('<-', response.status(), response.url());
      if (response.status() === 441) {
        console.log('Got 441 Recaptcha. Wait to see if Vue solves it...');
      }
    }
  });

  console.log('Loading app.uz.gov.ua...');
  await page.goto('https://app.uz.gov.ua/', { waitUntil: 'networkidle' });
  
  // Fill in inputs to trigger train search manually!
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    await inputs[0].type('Вінниця', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    await inputs[1].type('Тернопіль', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    
    // Choose date 2026-07-20
    const buttons = await page.$$('button');
    for (let btn of buttons) {
      const text = await btn.innerText();
      if (text && text.toLowerCase().includes('знайти')) {
        await btn.click();
        break;
      }
    }
  }

  await page.waitForTimeout(10000);
  await browser.close();
})();
