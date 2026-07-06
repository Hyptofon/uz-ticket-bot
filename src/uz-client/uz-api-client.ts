// src/uz-client/uz-api-client.ts
//
// UzApiClient — клієнт до booking.uz.gov.ua / app.uz.gov.ua
// Весь трафік іде через постійний Google Chrome (Playwright) для обходу Cloudflare Turnstile.
//
// API_NOTES.md (оновлюється після probe-скрипта):
//   GET  https://app.uz.gov.ua/api/stations?search={term}  → масив станцій
//   GET  https://app.uz.gov.ua/api/v3/trips?...             → список поїздів
//   POST https://booking.uz.gov.ua/purchase/coaches/        → список вагонів

import { CookieJar } from 'tough-cookie';
import { config } from '../config';
import { logger } from '../logger';
import { UzStation, UzTrain, UzWagon, UzTrainSearchResponse } from './types';
import { MonitorSnapshot, TrainSnapshot, WagonSnapshot } from '../db/types';

import * as fs from 'fs';
import * as path from 'path';

// ─── Rate limiter ────────────────────────────────────────────────────────────
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

function backoffDelay(attempt: number): number {
  return Math.min(5000 * Math.pow(2, attempt), 300_000);
}

/** Перевірка: чи відповідь є HTML (сторінка Cloudflare challenge) замість JSON */
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

// ─── Main Client ──────────────────────────────────────────────────────────────
export class UzApiClient {
  private currentUA: string;
  private profileDir: string;

  // Постійний браузер Google Chrome для обходу Cloudflare Turnstile
  private browserContext: any = null;
  private browserPage: any = null;
  private browserInitPromise: Promise<void> | null = null;
  private browserSessionId: string | null = null;
  private sessionRefreshedAt: number = 0;
  private readonly SESSION_TTL_MS = 25 * 60 * 1000;

  // Зберігаємо CookieJar тільки для сумісності з UzSessionManager
  private cookieJar: CookieJar;
  private sessionInitialized = false;

  constructor() {
    this.currentUA = randomUA();
    this.profileDir = path.join(process.cwd(), 'data', 'playwright-profile');
    this.cookieJar = new CookieJar();
  }

  // ─── Browser Init ───────────────────────────────────────────────────────────

  /**
   * Ініціалізує постійний Google Chrome ОДИН РАЗ.
   * Всі API-запити йдуть через браузер — так обходиться Cloudflare TLS-fingerprinting.
   */
  async ensureBrowserReady(): Promise<void> {
    if (this.browserPage) return;
    if (this.browserInitPromise) return this.browserInitPromise;

    this.browserInitPromise = (async () => {
      logger.info('Initializing persistent background browser for Cloudflare bypass...');
      const { chromium } = require('playwright-extra');
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromium.use(stealth);

      // Видаляємо SingletonLock файл блокування Chrome, який міг лишитися з минулого запуску.
      // Не використовуємо existsSync, бо для битих символьних лінків на Linux він повертає false.
      const lockFile = path.join(this.profileDir, 'SingletonLock');
      try {
        fs.rmSync(lockFile, { force: true });
      } catch (e) {}

      fs.mkdirSync(this.profileDir, { recursive: true });

      this.browserContext = await chromium.launchPersistentContext(this.profileDir, {
        headless: true,
        channel: 'chrome',
        userAgent: this.currentUA,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--allow-running-insecure-content',
        ],
      });

      this.browserPage = await this.browserContext.newPage();
      await this.browserPage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // 1. Відвідуємо спочатку app.uz.gov.ua (для trips/stations API)
      try {
        await this.browserPage.goto('https://app.uz.gov.ua/', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await this.browserPage.waitForTimeout(3000);
      } catch (err) {
        logger.warn({ err: String(err) }, 'app.uz.gov.ua load timeout, continuing...');
      }

      // 2. Відвідуємо booking.uz.gov.ua (для wagons API)
      try {
        await this.browserPage.goto('https://booking.uz.gov.ua/', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await this.browserPage.waitForTimeout(3000);
      } catch (err) {
        logger.warn({ err: String(err) }, 'booking.uz.gov.ua load timeout, continuing...');
      }

      // Намагаємося витягнути session ID з localStorage
      const sessionId = await this.browserPage.evaluate((): string | null => {
        const raw = localStorage.getItem('Symbol(AUTH_STORE_ID)');
        if (!raw) return null;
        try { return JSON.parse(raw).sessionId ?? null; } catch { return null; }
      }).catch(() => null);

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

  // ─── Core Fetch ─────────────────────────────────────────────────────────────

  /**
   * Виконує fetch всередині Google Chrome через page.evaluate.
   * Chrome вже пройшов Cloudflare, тому всі запити проходять без блокування.
   * contentType — 'application/json' (default) або 'application/x-www-form-urlencoded'
   */
  private async fetchViaBrowser(
    url: string,
    method: string = 'GET',
    body: any = null,
    contentType: string = 'application/json',
  ): Promise<any> {
    await this.ensureBrowserReady();
    await rateLimitWait();

    const result = await this.browserPage.evaluate(
      async ({ reqUrl, reqMethod, reqBody, reqContentType, sessionId }: any) => {
        const headers: Record<string, string> = {
          'Accept': 'application/json, text/plain, */*',
          'X-Client-Locale': 'uk',
          'X-User-Agent': 'UZ/2 Web/1 User/guest',
        };
        if (sessionId) headers['X-Session-Id'] = sessionId;
        if (reqBody) headers['Content-Type'] = reqContentType;

        const res = await fetch(reqUrl, {
          method: reqMethod,
          headers,
          body: reqBody ?? undefined,
        });

        if (!res.ok) {
          if (res.status === 403) throw new Error('BROWSER_FETCH_403');
          throw new Error(`HTTP ${res.status}`);
        }

        // Повертаємо текст, щоб перевірити на HTML (Cloudflare challenge)
        const text = await res.text();
        return text;
      },
      {
        reqUrl: url,
        reqMethod: method,
        reqBody: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
        reqContentType: contentType,
        sessionId: this.browserSessionId,
      },
    );

    // Перевіряємо чи це не HTML сторінка Cloudflare
    if (isHtmlResponse(result)) {
      logger.warn({ url }, 'Got HTML response instead of JSON — Cloudflare challenge detected');
      throw new Error('BROWSER_FETCH_403');
    }

    try {
      return JSON.parse(result);
    } catch {
      logger.error({ url, result: result?.slice?.(0, 200) }, 'Failed to parse JSON response');
      throw new Error('Invalid JSON response from UZ API');
    }
  }

  // ─── Session Management ─────────────────────────────────────────────────────

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

  // Методи для сумісності з UzSessionManager (не видаляємо — використовуються в fsm.ts і worker)
  getCookieJar(): CookieJar { return this.cookieJar; }
  getUserAgent(): string { return this.currentUA; }
  resetSession(): void { this.currentUA = randomUA(); logger.info('UA rotated'); }
  setSessionInitialized(v: boolean): void { this.sessionInitialized = v; }

  // ─── Public API Methods ─────────────────────────────────────────────────────

  /** Пошук станцій за рядком (автодоповнення) */
  async searchStations(term: string): Promise<UzStation[]> {
    try {
      const url = `https://app.uz.gov.ua/api/stations?search=${encodeURIComponent(term)}`;
      const data = await this.fetchViaBrowser(url);
      const stations = this.parseStations(data);
      logger.info({ term, count: stations.length }, 'Stations found');
      return stations;
    } catch (err: any) {
      if (err.message?.includes('BROWSER_FETCH_403')) {
        logger.warn({ term }, 'Station search blocked (403). Refreshing session...');
        await this.refreshBrowserSession();
        throw new CaptchaDetectedError('Оновлення сесії. Спробуйте ще раз.');
      }
      logger.error({ err: err.message, term }, 'searchStations error');
      return [];
    }
  }

  private parseStations(data: unknown): UzStation[] {
    try {
      if (Array.isArray(data)) {
        return data.map((item: Record<string, unknown>) => ({
          station_id: String(item.station_id ?? item.id ?? item.value ?? ''),
          title: String(item.title ?? item.name ?? item.label ?? ''),
          type: String(item.type ?? ''),
        })).filter(s => s.station_id && s.title);
      }
      if (data && typeof data === 'object' && 'data' in data) {
        const inner = (data as Record<string, unknown>).data;
        if (Array.isArray(inner)) return this.parseStations(inner);
      }
      logger.warn({ data: JSON.stringify(data).slice(0, 200) }, 'Unknown station response format');
      return [];
    } catch (err) {
      logger.error({ err }, 'Failed to parse station response');
      return [];
    }
  }

  /** Пошук поїздів на маршруті/даті */
  async searchTrains(
    fromStationId: string,
    toStationId: string,
    date: string, // YYYY-MM-DD
    fromName?: string,
    toName?: string,
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
        logger.info({ fromStationId, toStationId, date, count: trains.length }, 'Train search completed');
        return trains;
      } catch (err: any) {
        const isBlocked = err.message?.includes('BROWSER_FETCH_403');

        if (isBlocked) {
          logger.warn({ attempt }, 'Train search blocked (403). Refreshing browser session...');
          try {
            await this.refreshBrowserSession();
            if (attempt < maxRetries - 1) { await sleep(1000); continue; }
            throw new Error('УЗ API недоступне (блок Cloudflare)');
          } catch (browserErr) {
            if (attempt < maxRetries - 1) { await sleep(backoffDelay(attempt)); continue; }
            throw browserErr;
          }
        }

        logger.error({ err: err.message, attempt, fromStationId, toStationId, date }, 'searchTrains error');
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
          const toKyivTime = (ts: number): string => {
            if (!ts) return '--:--';
            const d = new Date(ts * 1000);
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
              price: wc.price,
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
        logger.warn({ data: JSON.stringify(data).slice(0, 300) }, 'Unknown train search response format');
        return [];
      }
      return list;
    } catch (err) {
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
        const [year, month, day] = date.split('-');
        const uzDate = `${day}.${month}.${year}`;

        const formBody = new URLSearchParams({
          from: fromStationId,
          to: toStationId,
          train: trainNum,
          date: uzDate,
        });

        const url = `https://booking.uz.gov.ua/purchase/coaches/`;
        const data = await this.fetchViaBrowser(url, 'POST', formBody.toString(), 'application/x-www-form-urlencoded');
        return this.parseWagons(data);
      } catch (err: any) {
        if (err.message?.includes('BROWSER_FETCH_403')) {
          logger.warn({ attempt }, 'Wagons fetch blocked (403). Refreshing...');
          try {
            await this.refreshBrowserSession();
            if (attempt < maxRetries - 1) { await sleep(1000); continue; }
            throw new Error('УЗ API недоступне (блок Cloudflare)');
          } catch (browserErr) {
            if (attempt < maxRetries - 1) continue;
            throw browserErr;
          }
        }
        logger.error({ err: err.message, attempt, trainNum }, 'getWagons error');
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
        logger.warn({ data: JSON.stringify(data).slice(0, 300) }, 'Unknown wagon response format');
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
}

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}
