const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async response => {
    if (response.url().includes('v3/trips')) {
      console.log('<< RESPONSE:', response.status(), response.url());
      try {
        const json = await response.json();
        console.log('BODY:', JSON.stringify(json, null, 2).slice(0, 1000));
      } catch (e) {
        console.log('Could not read body', e);
      }
    }
  });

  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    await inputs[0].type('Вінниця', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    await inputs[1].type('Київ', { delay: 100 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    
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
