// scripts/probe-uz-api.ts
// Milestone 1 — Розвідка API УЗ
// Запускати: npm run probe
// Результати записуються в src/uz-client/API_NOTES.md

import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://booking.uz.gov.ua';

const jar = new CookieJar();
const rawClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  withCredentials: true,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'uk-UA,uk;q=0.9',
    'Referer': `${BASE_URL}/`,
    'Origin': BASE_URL,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
});
const client = wrapper(rawClient);
(client.defaults as unknown as { jar: CookieJar }).jar = jar;

interface ProbeResult {
  endpoint: string;
  method: string;
  status?: number;
  responseType: 'json' | 'html' | 'error';
  sample?: unknown;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string | string[]>;
}

const results: ProbeResult[] = [];

async function probe(): Promise<void> {
  console.log('🔍 UZ API Probe Script');
  console.log('======================\n');

  // Step 1: Отримати головну сторінку (cookies)
  console.log('📡 Step 1: Loading main page to get cookies...');
  try {
    const resp = await client.get('/', {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const isHtml = typeof resp.data === 'string' && resp.data.includes('<html');
    console.log(`  Status: ${resp.status} | Type: ${isHtml ? 'HTML ✅' : 'JSON'}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jarData = jar.toJSON() as any;
    const cookieKeys = (jarData.cookies ?? []).map((c: any) => String(c?.key ?? '?')).join(', ');
    console.log(`  Cookies: ${cookieKeys}\n`);
  } catch (err: unknown) {
    const error = err as Error & { response?: { status: number } };
    console.log(`  ❌ Error: ${error.message}\n`);
  }

  await sleep(2000);

  // Step 2: Автодоповнення станцій
  const stationQueries = ['Козятин', 'Тернопіль', 'Вінниця', 'Київ'];

  for (const query of stationQueries) {
    console.log(`📡 Step 2: Station search for "${query}"...`);

    // Endpoint 1: /uk/train_search/station/
    await probeEndpoint({
      method: 'GET',
      url: '/uk/train_search/station/',
      params: { term: query },
    }, `Station autocomplete (${query})`);

    // Endpoint 2: Альтернативний формат
    await probeEndpoint({
      method: 'GET',
      url: '/api/train_search/station/',
      params: { term: query },
    }, `Station autocomplete alt (${query})`);

    await sleep(1500);
  }

  // Step 3: Пошук поїздів
  // Спочатку нам потрібні ID станцій — спробуємо знайти
  console.log('\n📡 Step 3: Train search (Козятин → Тернопіль, 20.07.2026)...\n');

  const testRequests = [
    { from: '2218000', to: '2208020', label: 'ID variant 1' },
    { from: 'Козятин 1', to: 'Тернопіль', label: 'Name variant' },
  ];

  for (const req of testRequests) {
    // POST form-encoded
    await probeEndpoint({
      method: 'POST',
      url: '/uk/train_search/train/',
      data: `from=${encodeURIComponent(req.from)}&to=${encodeURIComponent(req.to)}&date=20.07.2026&time=00:00`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, `Train search POST (${req.label})`);

    await sleep(2000);

    // GET variant
    await probeEndpoint({
      method: 'GET',
      url: '/uk/train_search/train/',
      params: {
        from: req.from,
        to: req.to,
        date: '20.07.2026',
      },
    }, `Train search GET (${req.label})`);

    await sleep(2000);
  }

  // Записати результати
  const notes = buildNotes(results);
  const notesPath = path.join(process.cwd(), 'src', 'uz-client', 'API_NOTES.md');
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  fs.writeFileSync(notesPath, notes, 'utf-8');

  console.log(`\n✅ Results saved to: ${notesPath}`);
  console.log(`\n📊 Summary: ${results.length} endpoints probed`);
  console.log(`  ✅ JSON responses: ${results.filter((r) => r.responseType === 'json').length}`);
  console.log(`  🌐 HTML responses: ${results.filter((r) => r.responseType === 'html').length}`);
  console.log(`  ❌ Errors: ${results.filter((r) => r.responseType === 'error').length}`);
}

async function probeEndpoint(
  reqConfig: {
    method: 'GET' | 'POST';
    url: string;
    params?: Record<string, string>;
    data?: string;
    headers?: Record<string, string>;
  },
  label: string,
): Promise<void> {
  console.log(`  🔍 ${label}: ${reqConfig.method} ${reqConfig.url}`);

  try {
    const resp = await client.request({
      method: reqConfig.method,
      url: reqConfig.url,
      params: reqConfig.params,
      data: reqConfig.data,
      headers: reqConfig.headers,
    });

    const isHtml = typeof resp.data === 'string' && resp.data.trim().startsWith('<');
    const responseType = isHtml ? 'html' : 'json';

    let sample: unknown;
    if (responseType === 'json') {
      sample = typeof resp.data === 'object'
        ? JSON.parse(JSON.stringify(resp.data, null, 2)).slice
          ? JSON.stringify(resp.data).slice(0, 1000)
          : JSON.stringify(resp.data, null, 2).slice(0, 1000)
        : String(resp.data).slice(0, 500);
    } else {
      sample = String(resp.data).slice(0, 200) + '...';
    }

    const result: ProbeResult = {
      endpoint: reqConfig.url,
      method: reqConfig.method,
      status: resp.status,
      responseType,
      sample,
      responseHeaders: Object.fromEntries(
        Object.entries(resp.headers).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>,
    };

    results.push(result);

    if (responseType === 'json') {
      console.log(`    ✅ Status: ${resp.status} | Response type: JSON`);
      if (typeof resp.data === 'object' && resp.data !== null) {
        const keys = Object.keys(resp.data as object);
        console.log(`    Keys: ${keys.join(', ')}`);
      }
    } else {
      console.log(`    🌐 Status: ${resp.status} | Response type: HTML (possible captcha/block)`);
    }
  } catch (err: unknown) {
    const error = err as Error & {
      response?: { status: number; data: unknown; headers: Record<string, string> };
    };

    const result: ProbeResult = {
      endpoint: reqConfig.url,
      method: reqConfig.method,
      status: error.response?.status,
      responseType: 'error',
      error: error.message,
    };

    if (error.response) {
      result.status = error.response.status;
      const isHtml =
        typeof error.response.data === 'string' &&
        error.response.data.trim().startsWith('<');
      if (isHtml) {
        result.responseType = 'html';
        result.sample = String(error.response.data).slice(0, 200);
      }
    }

    results.push(result);
    console.log(`    ❌ ${error.response?.status ?? 'Network'} Error: ${error.message}`);
  }

  await sleep(500);
}

function buildNotes(probeResults: ProbeResult[]): string {
  const timestamp = new Date().toISOString();

  return `# UZ API Notes — Empirical Research Results
<!-- Generated by probe-uz-api.ts on ${timestamp} -->
<!-- Run \`npm run probe\` to update -->

## Methodology

API was researched empirically by sending HTTP requests with browser-like headers.
This is the **source of truth** for UzApiClient implementation.
Results below override/confirm the assumptions in TZ section 7.

## Probe Results

${probeResults
  .map(
    (r, i) => `
### ${i + 1}. ${r.method} ${r.endpoint}

- **Status:** ${r.status ?? 'N/A'}
- **Response type:** ${r.responseType}
${r.error ? `- **Error:** ${r.error}` : ''}

${
  r.responseType === 'json'
    ? `\`\`\`json
${typeof r.sample === 'string' ? r.sample : JSON.stringify(r.sample, null, 2)}
\`\`\``
    : r.responseType === 'html'
    ? `**HTML/Captcha response** — bot protection active:\n\`\`\`\n${r.sample}\n\`\`\``
    : ''
}
`,
  )
  .join('\n---\n')}

## Implementation Notes

Based on probe results, update \`uz-api-client.ts\` accordingly:

1. If station search returns HTML → Cloudflare blocking. Use Playwright fallback.
2. If train search status 403 → Need to check if auth is required.
3. Actual station IDs for common routes (update after successful probe):
   - Козятин 1: TBD
   - Тернопіль: TBD
   - Вінниця: TBD

## Known Working Endpoints (to be confirmed)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /uk/train_search/station/ | GET | Station autocomplete |
| /uk/train_search/train/ | POST | Train search |
| /uk/train_search/coach/ | POST | Wagon list |
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

probe().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
