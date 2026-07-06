const { chromium } = require('playwright');

(async () => {
  console.log('Starting browser...');
  const browser = await chromium.launch({ headless: false }); // headless: false to avoid cloudflare
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('request', request => {
    if (request.url().includes('station') || request.url().includes('api')) {
      console.log('>> REQUEST:', request.method(), request.url());
      console.log('   HEADERS:', request.headers());
    }
  });

  page.on('response', async response => {
    if (response.url().includes('station') || response.url().includes('api')) {
      console.log('<< RESPONSE:', response.status(), response.url());
      try {
        const text = await response.text();
        console.log('   BODY:', text.slice(0, 500));
      } catch (e) {
        console.log('   Could not read body');
      }
    }
  });

  console.log('Navigating to booking.uz.gov.ua...');
  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle' });
  
  console.log('Waiting for inputs...');
  await page.waitForTimeout(3000);
  
  // Find the input field for station. Let's try to type "Вінниця"
  // Assuming it's the first input field or one with placeholder containing "Звідки"
  const inputs = await page.$$('input');
  if (inputs.length > 0) {
    console.log('Typing into the first input...');
    await inputs[0].type('Вінниця', { delay: 100 });
  } else {
    console.log('No inputs found!');
  }
  
  console.log('Waiting for network requests...');
  await page.waitForTimeout(5000);

  console.log('Done.');
  await browser.close();
})();
