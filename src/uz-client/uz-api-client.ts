// src/uz-client/uz-api-client.ts
//
// UzApiClient — HTTP-клієнт до booking.uz.gov.ua
// Інкапсулює заголовки, cookie jar, retry/backoff, парсинг відповіді.
//
// ВАЖЛИВО: booking.uz.gov.ua — неофіційне, недокументоване API.
// Реальні ендпоінти підтверджені зворотньою розробкою (DevTools).
// Якщо структура відповіді змінилась — шукати в src/uz-client/API_NOTES.md
//
// API_NOTES.md (оновлюється після probe-скрипта):
//   GET /uk/train_search/station/?term={query} → масив станцій
//   POST /uk/train_search/train/  → список поїздів
//   GET /uk/train_search/coach/?  → список вагонів для поїзда

import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { config } from '../config';
import { logger } from '../logger';
import { UzStation, UzTrain, UzWagon, UzTrainSearchResponse } from './types';
import { MonitorSnapshot, TrainSnapshot, WagonSnapshot } from '../db/types';

import * as fs from 'fs';
import * as path from 'path';

// Затримка між глобальними запитами (rate-limit)
let lastRequestTime = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const minInterval = config.polling.globalRequestMinIntervalMs;
  if (elapsed < minInterval) {
    await sleep(minInterval - elapsed);
  }
  lastRequestTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: 5s → 10s → 20s → ... → 300s */
function backoffDelay(attempt: number): number {
  return Math.min(5000 * Math.pow(2, attempt), 300_000);
}

/** Перевірка, чи відповідь містить HTML замість JSON (капча/блок Cloudflare) */
function isHtmlResponse(data: unknown): boolean {
  if (typeof data === 'string') {
    return data.trim().startsWith('<') || data.trim().includes('<!DOCTYPE html>');
  }
  return false;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export class UzApiClient {
  private httpClient: AxiosInstance;
  private cookieJar: CookieJar;
  private sessionInitialized = false;
  private currentUA: string;
  private profileDir: string;
  // Browser-harvested session (x-session-id + cookies from Vue app)
  private browserSessionId: string | null = null;
  private sessionRefreshedAt: number = 0;
  private readonly SESSION_TTL_MS = 25 * 60 * 1000; // 25 хвили

  constructor() {
    this.cookieJar = new CookieJar();
    this.currentUA = randomUA();
    this.profileDir = path.join(process.cwd(), 'data', 'playwright-profile');

    const rawClient = axios.create({
      baseURL: config.uz.baseUrl,
      timeout: 20_000,
      headers: this.buildHeaders(),
      withCredentials: true,
    });

    // axios-cookiejar-support: wrapper повертає той самий клієнт з cookie jar підтримкою
    // Jar передаємо через defaults.jar (v1+ API)
    try {
      const wrappedClient = wrapper(rawClient);
      if (wrappedClient && wrappedClient.defaults) {
        (wrappedClient.defaults as unknown as { jar: CookieJar }).jar = this.cookieJar;
        this.httpClient = wrappedClient;
      } else {
        // Fallback для тестового середовища де wrapper може повернути undefined
        this.httpClient = rawClient;
      }
    } catch {
      this.httpClient = rawClient;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.currentUA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${config.uz.baseUrl}/`,
      'Origin': 'https://booking.uz.gov.ua',
      'Sec-Ch-Ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'X-Client-Locale': 'uk',
      'X-User-Agent': 'UZ/2 Web/1 User/guest',
    };
    if (this.browserSessionId) {
      headers['X-Session-Id'] = this.browserSessionId;
    }
    return headers;
  }

  /**
   * Відкриває Chrome один раз, завантажує booking.uz.gov.ua і витягує
   * реальний x-session-id + cookies для всіх подальших axios-запитів.
   */
  async refreshBrowserSession(): Promise<void> {
    logger.info('Refreshing browser session (harvesting real sessionId + cookies)...');
    let context;
    try {
      const { chromium } = await import('playwright');
      fs.mkdirSync(this.profileDir, { recursive: true });

      context = await chromium.launchPersistentContext(this.profileDir, {
        headless: true, // Без вікна — тільки для отримання сесії!
        channel: 'chrome',
        userAgent: this.currentUA,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });

      const page = await context.newPage();
      // Відміняємо ознаку автоматизації
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Витягуємо sessionId з localStorage Vue-додатку
      const sessionId = await page.evaluate((): string | null => {
        const raw = localStorage.getItem('Symbol(AUTH_STORE_ID)');
        if (!raw) return null;
        try { return JSON.parse(raw).sessionId ?? null; } catch { return null; }
      });

      if (sessionId) {
        this.browserSessionId = sessionId;
        logger.info({ sessionId }, 'Harvested real x-session-id from Vue localStorage');
      } else {
        logger.warn('Could not extract sessionId from localStorage');
      }

      // Синхронізуємо cookies в axios jar
      const cookies = await context.cookies();
      for (const c of cookies) {
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        const cookieStr = `${c.name}=${c.value}; Domain=${domain}; Path=${c.path}`;
        await this.cookieJar.setCookie(cookieStr, `https://${domain}`);
      }
      logger.info({ count: cookies.length }, 'Synced browser cookies to axios jar');

      this.sessionRefreshedAt = Date.now();
      this.sessionInitialized = true;
      await context.close();
    } catch (err) {
      logger.error({ err }, 'Failed to refresh browser session');
      if (context) { try { await context.close(); } catch {} }
    }
  }

  /** Ініціалізація сесії: завантажити головну сторінку, отримати cookies */
  async initSession(): Promise<void> {
    if (this.sessionInitialized) return;

    try {
      logger.debug('Initializing UZ session...');
      await rateLimitWait();
      await this.httpClient.get('/', {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      this.sessionInitialized = true;
      logger.info('UZ session initialized (cookies obtained)');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize UZ session, will retry on next request');
    }
  }

  /**
   * Запасний метод для пошуку станцій через Playwright page.evaluate
   */
  private async searchStationsViaBrowser(term: string): Promise<UzStation[]> {
    logger.info({ term }, 'Axios blocked. Falling back to browser evaluation for stations...');
    
    // Очищаємо можливі заблоковані файли профілю Playwright перед запуском
    const lockPath = path.join(this.profileDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {
        logger.debug('Could not remove SingletonLock file, Chrome might handle it');
      }
    }

    let context;
    try {
      const { chromium } = await import('playwright');
      fs.mkdirSync(this.profileDir, { recursive: true });

      context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false, // Запускаємо з вікном, щоб Cloudflare пропустив
        channel: 'chrome', // Запускаємо локальний Google Chrome
        userAgent: this.currentUA,
      });

      const page = await context.newPage();
      
      // Переходимо на новий сайт
      await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      logger.info('Waiting 5s for Cloudflare challenge check in Chrome window...');
      await page.waitForTimeout(5000);

      const result = await page.evaluate(async (searchTerm) => {
        const url = `https://app.uz.gov.ua/api/stations?search=${encodeURIComponent(searchTerm)}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'x-user-agent': 'UZ/2 Web/1 User/guest'
          }
        });
        return response.json();
      }, term);

      await context.close();
      return this.parseStations(result);
    } catch (err) {
      logger.error({ err }, 'Failed to search stations via Playwright fallback');
      if (context) {
        try {
          await context.close();
        } catch (e) {}
      }
      throw err;
    }
  }

  /** Пошук станцій за рядком (автодоповнення) */
  async searchStations(term: string): Promise<UzStation[]> {
    await this.initSession();
    await rateLimitWait();

    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response: AxiosResponse = await this.httpClient.get(
          'https://app.uz.gov.ua/api/stations',
          {
            params: { search: term },
            headers: this.buildHeaders(),
          },
        );

        if (isHtmlResponse(response.data)) {
          logger.warn('UZ API returned HTML instead of JSON (possible CAPTCHA) for station search');
          throw new CaptchaDetectedError('HTML response detected (captcha/block)');
        }

        const data = response.data;
        const stations = this.parseStations(data);
        logger.debug({ term, count: stations.length }, 'Station search completed');
        return stations;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const isBlocked =
          err instanceof CaptchaDetectedError ||
          axiosErr.response?.status === 403 ||
          axiosErr.response?.status === 401 ||
          axiosErr.response?.status === 441;

        if (isBlocked) {
          try {
            // Переключаємось на браузерний запит
            return await this.searchStationsViaBrowser(term);
          } catch (browserErr) {
            if (attempt < maxRetries - 1) {
              await sleep(backoffDelay(attempt));
              continue;
            }
            throw browserErr;
          }
        }
        throw err;
      }
    }
    return [];
  }

  private parseStations(data: unknown): UzStation[] {
    try {
      // Формат 1: масив об'єктів [{station_id, title}]
      if (Array.isArray(data)) {
        return data.map((item: Record<string, unknown>) => ({
          station_id: String(item.station_id ?? item.id ?? item.value ?? ''),
          title: String(item.title ?? item.name ?? item.label ?? ''),
          type: String(item.type ?? ''),
        })).filter(s => s.station_id && s.title);
      }

      // Формат 2: {data: [{...}]}
      if (data && typeof data === 'object' && 'data' in data) {
        const inner = (data as Record<string, unknown>).data;
        if (Array.isArray(inner)) {
          return this.parseStations(inner);
        }
      }

      logger.warn({ data: JSON.stringify(data).slice(0, 200) }, 'Unknown station response format');
      return [];
    } catch (err) {
      logger.error({ err, data }, 'Failed to parse station response');
      return [];
    }
  }

  /**
   * Запасний метод: симулює реального користувача на booking.uz.gov.ua
   * Вводить станції, обирає зі списку підказок, обирає дату, клікає Знайти.
   * Перехоплює API-відповідь від v3/trips і повертає список поїздів.
   */
  private async searchTrainsViaBrowser(fromId: string, toId: string, date: string, fromName?: string, toName?: string): Promise<UzTrain[]> {
    logger.info({ fromId, toId, date, fromName, toName }, 'Falling back to browser UI simulation...');

    if (!fromName || !toName) {
      logger.warn('Cannot simulate UI without station names');
      return [];
    }

    let context;
    try {
      const { chromium } = await import('playwright');
      const fs = require('fs');
      fs.mkdirSync(this.profileDir, { recursive: true });

      context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        channel: 'chrome',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });

      const page = await context.newPage();

      // Helper: human typing with variable speed and mid-word pause
      const humanType = async (el: any, text: string) => {
        await el.fill('');
        const part1 = text.substring(0, Math.max(2, Math.floor(text.length / 2)));
        const part2 = text.substring(part1.length);
        for (const ch of part1) {
          await el.type(ch, { delay: Math.random() * 120 + 80 });
        }
        await page.waitForTimeout(500 + Math.random() * 500); // пауза — "думає"
        for (const ch of part2) {
          await el.type(ch, { delay: Math.random() * 100 + 70 });
        }
      };

      // Helper: click autocomplete item by text
      const clickAutocomplete = async (name: string): Promise<boolean> => {
        await page.waitForTimeout(1200); // чекаємо список
        // Спробуємо role=option
        const opts = await page.$$('[role="option"]');
        for (const opt of opts) {
          const t = (await opt.innerText().catch(() => '')).trim();
          if (t.toLowerCase().includes(name.toLowerCase())) {
            await opt.click();
            logger.info({ selected: t }, 'Selected from autocomplete via role=option');
            return true;
          }
        }
        // Запасний варіант: li елементи
        const lis = await page.$$('li');
        for (const li of lis) {
          const t = (await li.innerText().catch(() => '')).trim();
          if (t && t.toLowerCase().includes(name.toLowerCase())) {
            await li.click();
            logger.info({ selected: t }, 'Selected from autocomplete via li');
            return true;
          }
        }
        return false;
      };

      await page.goto('https://booking.uz.gov.ua/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000); // чекаємо завантаження Vue + CloudFlare

      // Чекаємо появи полів
      try {
        await page.waitForSelector('#fromStation', { timeout: 15000 });
      } catch {
        logger.warn('fromStation input not found, page may be blocked');
        await context.close();
        return [];
      }

      // === КРОК 1: Станція відправлення ===
      logger.info({ fromName }, 'Typing FROM station...');
      await page.click('#fromStation');
      await page.waitForTimeout(400);
      await humanType(await page.$('#fromStation'), fromName);
      const fromSelected = await clickAutocomplete(fromName);
      if (!fromSelected) {
        logger.warn({ fromName }, 'FROM autocomplete not found, aborting');
        await context.close();
        return [];
      }
      await page.waitForTimeout(600);

      // === КРОК 2: Станція прибуття ===
      logger.info({ toName }, 'Typing TO station...');
      const inputs = await page.$$('input');
      const toInput = inputs[1];
      await toInput.click();
      await page.waitForTimeout(400);
      await humanType(toInput, toName);
      const toSelected = await clickAutocomplete(toName);
      if (!toSelected) {
        logger.warn({ toName }, 'TO autocomplete not found, aborting');
        await context.close();
        return [];
      }
      await page.waitForTimeout(600);

      // === КРОК 3: Дата ===
      logger.info({ date }, 'Selecting date...');
      const dateInput = await page.$('#startDate');
      if (dateInput) {
        await dateInput.click();
        await page.waitForTimeout(1000);
      }
      let dateFound = false;
      for (let i = 0; i < 4; i++) {
        const el = await page.$(`#dp-${date}`);
        if (el) {
          await el.click();
          dateFound = true;
          logger.info({ date }, 'Date clicked in calendar');
          break;
        }
        const next = await page.$('[aria-label="Next month"]');
        if (next) { await next.click(); await page.waitForTimeout(700); } else break;
      }
      if (!dateFound) logger.warn({ date }, 'Date not found in calendar, using current');
      await page.waitForTimeout(800);

      // === КРОК 4: Встановлюємо перехоплення ПЕРЕД кліком Знайти ===
      logger.info('Setting up response interceptor...');
      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('v3/trips') && res.status() === 200,
        { timeout: 25000 }
      ).catch(() => null);

      // === КРОК 5: Клік "Знайти" ===
      logger.info('Clicking search button...');
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const t = await btn.innerText().catch(() => '');
        if (t.toLowerCase().includes('знайти')) {
          await btn.click();
          logger.info('Search button clicked');
          break;
        }
      }

      // === КРОК 6: Чекаємо на відповідь API ===
      logger.info('Waiting for v3/trips API response...');
      const response = await responsePromise;

      if (response) {
        logger.info({ status: response.status(), url: response.url() }, 'Got trips response!');
        const result = await response.json();
        await context.close();
        return this.parseTrains(result);
      } else {
        logger.warn('Timed out — no v3/trips response intercepted');
        await context.close();
        return [];
      }
    } catch (err) {
      logger.error({ err }, 'Failed in browser UI simulation');
      if (context) { try { await context.close(); } catch (e) {} }
      throw err;
    }
  }

  /** Пошук поїздів на маршруті/даті */

  async searchTrains(
    fromStationId: string,
    toStationId: string,
    date: string, // YYYY-MM-DD
    fromName?: string,
    toName?: string
  ): Promise<UzTrain[]> {
    await this.initSession();
    await rateLimitWait();

    // Формат дати для УЗ API: DD.MM.YYYY
    const [year, month, day] = date.split('-');
    const uzDate = `${day}.${month}.${year}`;

    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const [d, m, y] = uzDate.split('.');
        const dateIso = `${y}-${m}-${d}`;
        const url = `https://app.uz.gov.ua/api/v3/trips?station_from_id=${fromStationId}&station_to_id=${toStationId}&with_transfers=0&date=${dateIso}`;

        const response: AxiosResponse = await this.httpClient.get(url, {
          headers: this.buildHeaders(),
        });

        if (isHtmlResponse(response.data)) {
          throw new CaptchaDetectedError('HTML response detected in train search');
        }

        const trains = this.parseTrains(response.data);
        logger.debug(
          { fromStationId, toStationId, date, count: trains.length },
          'Train search completed',
        );
        return trains;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const isBlocked =
          err instanceof CaptchaDetectedError ||
          axiosErr.response?.status === 403 ||
          axiosErr.response?.status === 401 ||
          axiosErr.response?.status === 441;

        if (isBlocked) {
          try {
            return await this.searchTrainsViaBrowser(fromStationId, toStationId, date, fromName, toName);
          } catch (browserErr) {
            if (attempt < maxRetries - 1) {
              await sleep(backoffDelay(attempt));
              continue;
            }
            throw browserErr;
          }
        }
        throw err;
      }
    }
    return [];
  }

  private parseTrains(data: unknown): UzTrain[] {
    try {
      const obj = data as UzTrainSearchResponse;

      // v3 format: obj.direct = [{ train: { number, ... }, wagon_classes: [...] }]
      if (obj && Array.isArray((obj as any).direct)) {
        return (obj as any).direct.map((item: any) => {
          const t = item.train;
          // Конвертуємо Unix timestamp в людський час (Київ, UTC+3)
          const toKyivTime = (ts: number): string => {
            if (!ts) return '--:--';
            const d = new Date(ts * 1000);
            const h = String(d.getUTCHours() + 3).padStart(2, '0');
            const hNum = d.getUTCHours() + 3;
            const hFinal = String(hNum >= 24 ? hNum - 24 : hNum).padStart(2, '0');
            const m = String(d.getUTCMinutes()).padStart(2, '0');
            return `${hFinal}:${m}`;
          };
          const totalSeats = (t.wagon_classes || []).reduce((sum: number, wc: any) => sum + (wc.free_seats || 0), 0);
          return {
            num: t.number,
            title: `${t.station_from} - ${t.station_to}`,
            departure_time: toKyivTime(item.depart_at),
            arrival_time: toKyivTime(item.arrive_at),
            free_seats: totalSeats,
            types: (t.wagon_classes || []).map((wc: any) => ({
              id: wc.id,
              title: wc.name,
              places: wc.free_seats,
              price: wc.price, // v3 returns in kopecks
            }))
          };
        }) as UzTrain[];
      }

      // Legacy format
      const list =
        obj?.data?.list ??
        obj?.trains ??
        obj?.list ??
        (Array.isArray(data) ? (data as UzTrain[]) : null);

      if (!list || !Array.isArray(list)) {
        logger.warn(
          { data: JSON.stringify(data).slice(0, 300) },
          'Unknown train search response format',
        );
        return [];
      }

      return list;
    } catch (err) {
      // Парсер не падає весь процес — логуємо і повертаємо []
      logger.error({ err, raw: JSON.stringify(data).slice(0, 500) }, 'Failed to parse train list');
      return [];
    }
  }

  /** Отримання вагонів для конкретного поїзда */
  async getWagons(
    trainNum: string,
    fromStationId: string,
    toStationId: string,
    date: string, // YYYY-MM-DD
  ): Promise<UzWagon[]> {
    await this.initSession();
    await rateLimitWait();

    const [year, month, day] = date.split('-');
    const uzDate = `${day}.${month}.${year}`;

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const formData = new URLSearchParams({
          from: fromStationId,
          to: toStationId,
          train: trainNum,
          date: uzDate,
          // Час: беремо порожній або 00:00 — уточнити по API_NOTES.md
        });

        const response: AxiosResponse = await this.httpClient.post(
          '/purchase/coaches/',
          formData.toString(),
          {
            headers: {
              ...this.buildHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        if (isHtmlResponse(response.data)) {
          throw new CaptchaDetectedError('HTML response detected in wagon request');
        }

        return this.parseWagons(response.data);
      } catch (err) {
        if (err instanceof CaptchaDetectedError) throw err;

        const axiosErr = err as AxiosError;
        logger.warn(
          { err: axiosErr.message, attempt, trainNum },
          'Wagon request failed',
        );

        if (attempt < maxRetries - 1) {
          await sleep(backoffDelay(attempt));
        } else {
          throw err;
        }
      }
    }
    return [];
  }

  private parseWagons(data: unknown): UzWagon[] {
    try {
      const obj = data as Record<string, unknown>;
      const wagons =
        (obj?.wagons as UzWagon[]) ??
        (obj?.coaches as UzWagon[]) ??
        (Array.isArray(data) ? (data as UzWagon[]) : null);

      if (!wagons || !Array.isArray(wagons)) {
        logger.warn(
          { data: JSON.stringify(data).slice(0, 300) },
          'Unknown wagon response format',
        );
        return [];
      }

      return wagons;
    } catch (err) {
      logger.error({ err }, 'Failed to parse wagon response');
      return [];
    }
  }

  /**
   * Головний метод для Worker — отримати знімок доступності для монітора.
   * Повертає MonitorSnapshot з усіма поїздами та їх вагонами.
   */
  async getAvailabilitySnapshot(
    fromStationId: string,
    toStationId: string,
    date: string,
    fromStationName?: string,
    toStationName?: string,
    trainNumber?: string | null,
    wagonTypes?: string[] | null,
    seatPosition?: 'lower' | 'upper' | 'any',
  ): Promise<MonitorSnapshot> {
    const trains = await this.searchTrains(fromStationId, toStationId, date, fromStationName, toStationName);

    const filteredTrains = trainNumber
      ? trains.filter((t) => this.matchesTrainNumber(t.num, trainNumber))
      : trains;

    const trainSnapshots: TrainSnapshot[] = [];

    for (const train of filteredTrains) {
      // Якщо у відповіді вже є типи з місцями — використовуємо їх
      if (train.types && Array.isArray(train.types) && train.types.length > 0) {
        const wagonSnaps = train.types
          .filter((wt) => !wagonTypes || this.matchesWagonType(wt.title || wt.id, wagonTypes))
          .map(
            (wt): WagonSnapshot => ({
              number: '?',
              type: wt.title || wt.id,
              typeCode: wt.id,
              freeSeats: wt.places ?? 0,
              freeSeatsLower: 0,
              freeSeatsUpper: 0,
              price: Math.round((wt.price ?? 0) / 100),
              hasCond: false,
            }),
          );

        const filtered = this.filterBySeatPosition(wagonSnaps, seatPosition ?? 'any');
        const totalFree = filtered.reduce((sum, w) => sum + w.freeSeats, 0);

        if (totalFree > 0) {
          trainSnapshots.push({
            trainNumber: train.num,
            trainName: train.title,
            departureTime: train.departure_time,
            arrivalTime: train.arrival_time,
            wagons: filtered,
            totalFreeSeats: totalFree,
          });
        }
      }
    }

    return {
      trains: trainSnapshots,
      checkedAt: new Date().toISOString(),
    };
  }

  private matchesTrainNumber(trainNum: string, target: string): boolean {
    const normalize = (s: string) => s.replace(/\s/g, '').toUpperCase();
    return normalize(trainNum).includes(normalize(target)) ||
      normalize(target).includes(normalize(trainNum));
  }

  private matchesWagonType(typeTitle: string, allowedTypes: string[]): boolean {
    const norm = typeTitle.toLowerCase();
    return allowedTypes.some((allowed) => norm.includes(allowed.toLowerCase()));
  }

  private filterBySeatPosition(
    wagons: WagonSnapshot[],
    position: 'lower' | 'upper' | 'any',
  ): WagonSnapshot[] {
    if (position === 'any') return wagons;
    return wagons.filter((w) => {
      if (position === 'lower') return w.freeSeatsLower > 0;
      if (position === 'upper') return w.freeSeatsUpper > 0;
      return true;
    });
  }

  /** Скинути сесію (використовується при блокуванні) */
  resetSession(): void {
    this.cookieJar = new CookieJar();
    this.sessionInitialized = false;
    this.currentUA = randomUA();
    logger.info('UZ session reset');
  }

  getCookieJar(): CookieJar {
    return this.cookieJar;
  }

  getUserAgent(): string {
    return this.currentUA;
  }

  setSessionInitialized(initialized: boolean): void {
    this.sessionInitialized = initialized;
  }
}

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}
