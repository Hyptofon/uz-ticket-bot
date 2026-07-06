const { chromium } = require('playwright');

async function humanType(element, text, page) {
  await element.fill('');
  const part1 = text.substring(0, 3);
  const part2 = text.substring(3);

  for (const char of part1) {
    await element.type(char, { delay: Math.random() * 100 + 100 });
  }
  await page.waitForTimeout(600 + Math.random() * 400);
  for (const char of part2) {
    await element.type(char, { delay: Math.random() * 80 + 80 });
  }
}

function convertDate(dateStr) {
  const [d, m, y] = dateStr.split('.');
  return `${y}-${m}-${d}`;
}

(async () => {
  const fromName = 'Вінниця';
  const toName = 'Тернопіль';
  const date = '20.07.2026';
  const dateIso = convertDate(date);

  console.log('Launching Chrome...');
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept BEFORE navigation
  let captchaShown = false;
  page.on('response', async (response) => {
    if (response.url().includes('v3/trips')) {
      console.log(`[RESPONSE] ${response.status()} ${response.url()}`);
    }
  });

  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Step 1: FROM
  console.log(`Typing FROM: ${fromName}`);
  await page.click('#fromStation');
  await page.waitForTimeout(400);
  await humanType(await page.$('#fromStation'), fromName, page);
  await page.waitForTimeout(1500);

  // Find and click the first dropdown item matching fromName
  try {
    await page.waitForSelector('[role="option"]', { timeout: 5000 });
    const opts = await page.$$('[role="option"]');
    for (const opt of opts) {
      const t = (await opt.innerText()).trim();
      if (t.includes(fromName)) { await opt.click(); console.log('FROM selected:', t); break; }
    }
  } catch {
    console.log('FROM: no role=option dropdown, trying li items');
    const lis = await page.$$('li');
    for (const li of lis) {
      const t = (await li.innerText().catch(() => '')).trim();
      if (t.includes(fromName)) { await li.click(); console.log('FROM selected li:', t); break; }
    }
  }
  await page.waitForTimeout(800);

  // Step 2: TO
  console.log(`Typing TO: ${toName}`);
  const inputs = await page.$$('input');
  await inputs[1].click();
  await page.waitForTimeout(400);
  await humanType(inputs[1], toName, page);
  await page.waitForTimeout(1500);

  try {
    await page.waitForSelector('[role="option"]', { timeout: 5000 });
    const opts = await page.$$('[role="option"]');
    for (const opt of opts) {
      const t = (await opt.innerText()).trim();
      if (t.includes(toName)) { await opt.click(); console.log('TO selected:', t); break; }
    }
  } catch {
    const lis = await page.$$('li');
    for (const li of lis) {
      const t = (await li.innerText().catch(() => '')).trim();
      if (t.includes(toName)) { await li.click(); console.log('TO selected li:', t); break; }
    }
  }
  await page.waitForTimeout(800);

  // Step 3: DATE
  console.log(`Selecting date: ${dateIso}`);
  await page.click('#startDate');
  await page.waitForTimeout(1000);
  let dateFound = false;
  for (let i = 0; i < 4; i++) {
    const el = await page.$(`#dp-${dateIso}`);
    if (el) { await el.click(); dateFound = true; console.log('Date clicked!'); break; }
    const next = await page.$('[aria-label="Next month"]');
    if (next) { await next.click(); await page.waitForTimeout(700); } else break;
  }
  if (!dateFound) console.log('DATE NOT FOUND');
  await page.waitForTimeout(800);

  // Step 4: SEARCH
  console.log('Clicking search...');
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const t = await btn.innerText().catch(() => '');
    if (t.toLowerCase().includes('знайти')) { await btn.click(); console.log('Search clicked!'); break; }
  }

  // Step 5: Wait for either CAPTCHA or result
  // If captcha appears, we have to wait for user to solve it (or wait longer)
  console.log('Waiting for result or CAPTCHA...');
  
  // Try waiting up to 45s for trips response OR page content to show trains
  let trains = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    await page.waitForTimeout(5000);
    
    // Check if captcha is visible
    const captchaVisible = await page.$('iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha').catch(() => null);
    if (captchaVisible) {
      console.log(`[Attempt ${attempt+1}] CAPTCHA detected, waiting for user to solve...`);
      continue;
    }

    // Try to extract trips data from the page
    const pageData = await page.evaluate(() => {
      // Try to get Vue data from Nuxt store
      const nuxt = window.__nuxt__;
      if (nuxt && nuxt.$store) {
        const state = nuxt.$store.state;
        return JSON.stringify(state);
      }
      // Try looking for train numbers visible on page
      const trainEls = document.querySelectorAll('[data-test-id*="train"], [class*="train"], [class*="Train"]');
      return Array.from(trainEls).map(el => el.textContent).join('|||');
    });
    
    if (pageData && pageData.length > 10) {
      console.log(`[Attempt ${attempt+1}] Page data found:`, pageData.substring(0, 200));
    }

    // Check page URL - if redirected to trips page, extract from URL
    const url = page.url();
    console.log(`[Attempt ${attempt+1}] URL: ${url}`);

    // Check for "no tickets" message
    const noTickets = await page.$eval('body', el => el.textContent).catch(() => '');
    if (noTickets.includes('Продаж ще не відкрився') || noTickets.includes('не знайдено')) {
      console.log('Page shows "no tickets" or "sale not open yet"');
      break;
    }
    if (noTickets.includes('Плацкарт') || noTickets.includes('Купе') || noTickets.includes('Люкс')) {
      console.log('Trains found on page!');
      break;
    }
  }

  await page.screenshot({ path: 'scratch/final_v2.png' });
  console.log('Done. Check scratch/final_v2.png');
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); });
