const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.uz.gov.ua/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const url = 'https://app.uz.gov.ua/api/v3/trips?station_from_id=2200200&station_to_id=2218300&with_transfers=0&date=2026-07-20';
  
  let result = await page.evaluate(async (u) => {
    const response = await fetch(u, {
      method: 'GET',
      headers: { 'x-user-agent': 'UZ/2 Web/1 User/guest' }
    });
    return { status: response.status, body: await response.json() };
  }, url);

  if (result.status === 441 && result.body.recaptcha_link) {
    console.log('Got 441 Recaptcha! Navigating to recaptcha link...');
    await page.goto(result.body.recaptcha_link, { waitUntil: 'domcontentloaded' });
    
    console.log('Waiting 10s for Recaptcha bypass...');
    await page.waitForTimeout(10000);
    
    console.log('Retrying fetch...');
    result = await page.evaluate(async (u) => {
      const response = await fetch(u, {
        method: 'GET',
        headers: { 'x-user-agent': 'UZ/2 Web/1 User/guest' }
      });
      return { status: response.status, body: await response.json() };
    }, url);
  }

  console.log('Result:', JSON.stringify(result, null, 2).slice(0, 500));
  await browser.close();
})();
