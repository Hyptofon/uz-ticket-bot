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
  // Persistent browser context to bypass Cloudflare Turnstile TLS fingerprinting
  private browserContext: any = null;
  private browserPage: any = null;
  private browserInitPromise: Promise<void> | null = null;
  private browserSessionId: string | null = null;
  private sessionRefreshedAt: number = 0;
  private readonly SESSION_TTL_MS = 25 * 60 * 1000;

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
   * Initializes the persistent background browser ONCE.
   * All API requests will be routed through this browser's fetch to inherit its TLS fingerprint.
   */
  async ensureBrowserReady(): Promise<void> {
    if (this.browserPage) return;
    if (this.browserInitPromise) return this.browserInitPromise;

    this.browserInitPromise = (async () => {
      logger.info('Initializing persistent background browser for Cloudflare bypass...');
      const { chromium } = require('playwright-extra');
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromium.use(stealth);

      fs.mkdirSync(this.profileDir, { recursive: true });

      this.browserContext = await chromium.launchPersistentContext(this.profileDir, {
        headless: true,
        channel: 'chrome',
        userAgent: this.currentUA,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });

      this.browserPage = await this.browserContext.newPage();
      await this.browserPage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      await this.browserPage.goto('https://booking.uz.gov.ua/', { waitUntil: 'networkidle', timeout: 45000 });
      await this.browserPage.waitForTimeout(3000);

      const sessionId = await this.browserPage.evaluate((): string | null => {
        const raw = localStorage.getItem('Symbol(AUTH_STORE_ID)');
        if (!raw) return null;
        try { return JSON.parse(raw).sessionId ?? null; } catch { return null; }
      });

      if (sessionId) {
        this.browserSessionId = sessionId;
        logger.info({ sessionId }, 'Harvested real x-session-id');
      }

      this.sessionInitialized = true;
      this.sessionRefreshedAt = Date.now();
      logger.info('Background browser is ready.');
    })();

    await this.browserInitPromise;
  }

  /** 
   * Execute fetch inside the background browser context.
   * Bypasses Turnstile perfectly since it's an actual Chrome process.
   */
  private async fetchViaBrowser(url: string, method: string = 'GET', body: any = null): Promise<any> {
    await this.ensureBrowserReady();
    await rateLimitWait();
    
    return await this.browserPage.evaluate(async ({ reqUrl, reqMethod, reqBody, sessionId }: any) => {
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'X-Client-Locale': 'uk',
        'X-User-Agent': 'UZ/2 Web/1 User/guest',
      };
      if (sessionId) headers['X-Session-Id'] = sessionId;
      if (reqBody) headers['Content-Type'] = 'application/json';

      const res = await fetch(reqUrl, {
        method: reqMethod,
        headers,
        body: reqBody ? JSON.stringify(reqBody) : undefined,
      });

      if (!res.ok) {
        if (res.status === 403) throw new Error('BROWSER_FETCH_403');
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    }, { reqUrl: url, reqMethod: method, reqBody: body, sessionId: this.browserSessionId });
  }

  async refreshBrowserSession(): Promise<void> {
    logger.warn('Refreshing browser session manually...');
    if (this.browserContext) {
      await this.browserContext.close().catch(() => {});
      this.browserPage = null;
      this.browserContext = null;
      this.browserInitPromise = null;
    }
    await this.ensureBrowserReady();
  }

  /** Пошук станцій за рядком (автодоповнення) */
  async searchStations(term: string): Promise<UzStation[]> {
    await this.ensureBrowserReady();
    try {
      const url = `https://app.uz.gov.ua/api/stations?search=${encodeURIComponent(term)}`;
      const data = await this.fetchViaBrowser(url);
      return this.parseStations(data);
    } catch (err: any) {
      if (err.message && err.message.includes('BROWSER_FETCH_403')) {
        logger.warn('Browser fetch blocked (403) in searchStations. Refreshing...');
        await this.refreshBrowserSession();
        throw new CaptchaDetectedError('Оновлення сесії. Спробуйте ще раз.');
      }
      logger.error({ err, term }, 'Failed to search stations via fetch');
      return [];
    }
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



  /** Пошук поїздів на маршруті/даті */

  async searchTrains(
    fromStationId: string,
    toStationId: string,
    date: string, // YYYY-MM-DD
    fromName?: string,
    toName?: string
  ): Promise<UzTrain[]> {
    await this.ensureBrowserReady();

    const [year, month, day] = date.split('-');
    const uzDate = `${day}.${month}.${year}`;

    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const [d, m, y] = uzDate.split('.');
        const dateIso = `${y}-${m}-${d}`;
        const url = `https://app.uz.gov.ua/api/v3/trips?station_from_id=${fromStationId}&station_to_id=${toStationId}&with_transfers=0&date=${dateIso}`;

        const data = await this.fetchViaBrowser(url);

        const trains = this.parseTrains(data);
        logger.debug(
          { fromStationId, toStationId, date, count: trains.length },
          'Train search completed (via browser fetch)',
        );
        return trains;
      } catch (err: any) {
        const isBlocked = err.message && err.message.includes('BROWSER_FETCH_403');

        if (isBlocked) {
          logger.warn('Browser fetch blocked (403). Refreshing browser session...');
          try {
            await this.refreshBrowserSession();
            if (attempt < maxRetries - 1) {
              await sleep(1000);
              continue;
            }
            throw new Error('УЗ API недоступне (блок Cloudflare)');
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

  async getWagons(
    trainNum: string,
    fromStationId: string,
    toStationId: string,
    date: string, // YYYY-MM-DD
  ): Promise<UzWagon[]> {
    await this.ensureBrowserReady();
    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // v3/wagons expects POST with JSON body:
        // { from: "...", to: "...", date: "...", trainNumber: "...", model: 0 }
        // Wait, the original method sent formData to /purchase/coaches/.
        // Let's adapt it to use fetchViaBrowser with the original /purchase/coaches/ endpoint.
        const [year, month, day] = date.split('-');
        const uzDate = `${day}.${month}.${year}`;

        const formData = new URLSearchParams({
          from: fromStationId,
          to: toStationId,
          train: trainNum,
          date: uzDate,
        });

        const url = `https://booking.uz.gov.ua/purchase/coaches/`;
        // Since it's application/x-www-form-urlencoded, we can pass it as a body string, but our fetch wrapper sets Content-Type to application/json if reqBody is present.
        // Let's modify fetchViaBrowser call. Wait! If I just pass the string, fetchViaBrowser will stringify it again.
        // Let's use GET /v3/wagons if possible... No, wait, let's just make fetchViaBrowser support urlencoded.
        // Actually, the new architecture uses fetchViaBrowser for JSON. I'll just use page.evaluate directly here for the specific formData!
        
        const data = await this.browserPage.evaluate(async ({ reqUrl, reqBody, sessionId }: any) => {
          const headers: Record<string, string> = {
            'Accept': 'application/json, text/plain, */*',
            'X-Client-Locale': 'uk',
            'X-User-Agent': 'UZ/2 Web/1 User/guest',
            'Content-Type': 'application/x-www-form-urlencoded'
          };
          if (sessionId) headers['X-Session-Id'] = sessionId;

          const res = await fetch(reqUrl, {
            method: 'POST',
            headers,
            body: reqBody,
          });

          if (!res.ok) {
            if (res.status === 403) throw new Error('BROWSER_FETCH_403');
            throw new Error(`HTTP ${res.status}`);
          }
          return await res.json();
        }, { reqUrl: url, reqBody: formData.toString(), sessionId: this.browserSessionId });

        return this.parseWagons(data);
      } catch (err: any) {
        if (err.message && err.message.includes('BROWSER_FETCH_403')) {
          logger.warn('Browser fetch blocked (403) in getWagons. Refreshing...');
          try {
            await this.refreshBrowserSession();
            if (attempt < maxRetries - 1) {
              await sleep(1000);
              continue;
            }
            throw new Error('УЗ API недоступне (блок Cloudflare)');
          } catch (browserErr) {
            if (attempt < maxRetries - 1) continue;
            throw browserErr;
          }
        }
        throw err;
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
