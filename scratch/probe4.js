const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.uz.gov.ua/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(async () => {
    const url = 'https://app.uz.gov.ua/api/v3/trips?station_from_id=2200200&station_to_id=2218300&with_transfers=0&date=2026-07-20';
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-user-agent': 'UZ/2 Web/1 User/guest'
      }
    });
    return { status: response.status, body: await response.json() };
  });

  console.log('Result:', JSON.stringify(result, null, 2));
  await browser.close();
})();
