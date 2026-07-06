const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('request', request => {
    if (request.url().includes('api') || request.url().includes('search') || request.url().includes('purchase')) {
      console.log('>> REQUEST:', request.method(), request.url());
      console.log('   HEADERS:', request.headers());
    }
  });

  page.on('response', async response => {
    if (response.url().includes('api') || response.url().includes('search') || response.url().includes('purchase')) {
      console.log('<< RESPONSE:', response.status(), response.url());
    }
  });

  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    console.log('Typing From...');
    await inputs[0].type('Вінниця', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    console.log('Typing To...');
    await inputs[1].type('Київ', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    
    console.log('Clicking Search button...');
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
