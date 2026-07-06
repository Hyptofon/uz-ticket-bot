const { chromium } = require('playwright');

// Helper to type like a human - split into parts with pauses
async function humanType(element, text) {
  await element.fill('');
  const part1 = text.substring(0, 3);
  const part2 = text.substring(3);

  for (const char of part1) {
    await element.type(char, { delay: Math.random() * 100 + 100 });
  }
  await new Promise(r => setTimeout(r, 600 + Math.random() * 400)); // pause like thinking
  for (const char of part2) {
    await element.type(char, { delay: Math.random() * 100 + 100 });
  }
}

// Convert date from dd.mm.yyyy to yyyy-mm-dd
function convertDate(dateStr) {
  const [d, m, y] = dateStr.split('.');
  return `${y}-${m}-${d}`;
}

(async () => {
  console.log('Launching Chrome...');
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const fromName = 'Вінниця';
  const toName = 'Тернопіль';
  const date = '20.07.2026';
  const dateIso = convertDate(date); // 2026-07-20

  console.log(`Navigating to booking.uz.gov.ua...`);
  await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Set up interceptor for trips response
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('v3/trips') && res.status() === 200,
    { timeout: 30000 }
  ).catch(() => null);

  // --- Step 1: Type FROM station ---
  console.log(`Typing FROM station: ${fromName}`);
  const fromInput = await page.waitForSelector('#fromStation', { timeout: 10000 });
  await fromInput.click();
  await page.waitForTimeout(400);
  await humanType(fromInput, fromName);
  await page.waitForTimeout(1500); // wait for autocomplete dropdown

  // Look for dropdown items - find the one that EXACTLY matches fromName
  console.log('Looking for autocomplete dropdown items...');
  const fromDropdownItems = await page.$$('[role="option"], [data-test-id*="station"], .autocomplete-item, li[class*="suggestion"], li[class*="option"]');
  console.log(`Found ${fromDropdownItems.length} dropdown items`);
  
  // Try to find and click exact match
  let fromSelected = false;
  for (const item of fromDropdownItems) {
    const text = (await item.innerText()).trim();
    console.log('  Item:', text);
    if (text.toLowerCase().includes(fromName.toLowerCase())) {
      await item.click();
      console.log(`  Clicked: "${text}"`);
      fromSelected = true;
      break;
    }
  }

  if (!fromSelected) {
    // Fallback: take screenshot and try ArrowDown
    console.log('Exact match not found, trying ArrowDown...');
    await page.screenshot({ path: 'scratch/step1_dropdown.png' });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scratch/step1_after_from.png' });
  console.log('Step 1 done.');

  // --- Step 2: Type TO station ---
  console.log(`Typing TO station: ${toName}`);
  // Re-query inputs because Vue may have re-rendered
  const inputs = await page.$$('input');
  const toInput = inputs[1];
  await toInput.click();
  await page.waitForTimeout(400);
  await humanType(toInput, toName);
  await page.waitForTimeout(1500); // wait for autocomplete

  console.log('Looking for TO autocomplete items...');
  const toDropdownItems = await page.$$('[role="option"], [data-test-id*="station"], .autocomplete-item, li[class*="suggestion"], li[class*="option"]');
  console.log(`Found ${toDropdownItems.length} dropdown items`);

  let toSelected = false;
  for (const item of toDropdownItems) {
    const text = (await item.innerText()).trim();
    console.log('  Item:', text);
    if (text.toLowerCase().includes(toName.toLowerCase())) {
      await item.click();
      console.log(`  Clicked: "${text}"`);
      toSelected = true;
      break;
    }
  }

  if (!toSelected) {
    console.log('Exact match not found, trying ArrowDown...');
    await page.screenshot({ path: 'scratch/step2_dropdown.png' });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scratch/step2_after_to.png' });
  console.log('Step 2 done.');

  // --- Step 3: Select date ---
  console.log(`Selecting date: ${date} (${dateIso})`);
  const dateInput = await page.$('#startDate');
  await dateInput.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scratch/step3_calendar.png' });

  let dateFound = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const dateEl = await page.$(`#dp-${dateIso}`);
    if (dateEl) {
      await dateEl.click();
      dateFound = true;
      console.log(`  Date ${dateIso} clicked!`);
      break;
    }
    console.log(`  Date not found on this month, going to next...`);
    const nextBtn = await page.$('[aria-label="Next month"]');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(800);
    } else {
      break;
    }
  }

  if (!dateFound) {
    console.log('DATE NOT FOUND!');
    await page.screenshot({ path: 'scratch/step3_date_fail.png' });
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scratch/step3_after_date.png' });
  console.log('Step 3 done.');

  // --- Step 4: Click "Знайти" ---
  console.log('Clicking search button...');
  const buttons = await page.$$('button');
  let searchClicked = false;
  for (const btn of buttons) {
    const text = await btn.innerText().catch(() => '');
    if (text.toLowerCase().includes('знайти')) {
      await btn.click();
      searchClicked = true;
      console.log('  Search button clicked!');
      break;
    }
  }
  if (!searchClicked) {
    console.log('Search button not found!');
  }

  // --- Step 5: Wait for trips response ---
  console.log('Waiting for v3/trips response...');
  const response = await responsePromise;
  if (response) {
    const data = await response.json();
    const count = data.direct ? data.direct.length : 0;
    console.log(`SUCCESS! Got ${count} direct trains.`);
    if (count > 0) {
      console.log('First train:', data.direct[0].train.number, data.direct[0].depart_at);
    }
  } else {
    console.log('TIMEOUT - no trips response intercepted');
  }

  await page.screenshot({ path: 'scratch/final_result.png' });
  await browser.close();
  console.log('Done.');
})().catch(e => { console.error('FATAL ERROR:', e.message); process.exit(1); });
