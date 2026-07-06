const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Loading app.uz.gov.ua...');
  await page.goto('https://app.uz.gov.ua/', { waitUntil: 'networkidle' });
  
  // Wait a bit for any Turnstile/Recaptcha to auto-solve in the background
  console.log('Waiting 5s for background auth...');
  await page.waitForTimeout(5000);
  
  console.log('Fetching trains...');
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

  console.log('Result:', JSON.stringify(result, null, 2).slice(0, 500));
  await browser.close();
})();
