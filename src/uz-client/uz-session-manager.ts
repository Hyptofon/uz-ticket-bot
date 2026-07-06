// src/uz-client/uz-session-manager.ts
// UzSessionManager — керування сесією та синхронізація cookies

import * as fs from 'fs';
import * as path from 'path';
import { CookieJar } from 'tough-cookie';
import { logger } from '../logger';

export class UzSessionManager {
  private playwrightAvailable = false;
  private captchaNotified = new Set<number>();
  private profileDir: string;

  constructor() {
    this.profileDir = path.join(process.cwd(), 'data', 'playwright-profile');
    this.checkPlaywright();
  }

  private async checkPlaywright(): Promise<void> {
    try {
      require.resolve('playwright');
      this.playwrightAvailable = true;
      logger.debug('Playwright is available for session operations');
    } catch {
      this.playwrightAvailable = false;
      logger.debug('Playwright is not available');
    }
  }

  /**
   * Обробка виявлення капчі для конкретного монітора.
   */
  handleCaptchaDetected(monitorId: number): string | null {
    if (this.captchaNotified.has(monitorId)) return null;
    this.captchaNotified.add(monitorId);

    logger.warn({ monitorId }, 'CAPTCHA / Challenge detected for monitor');
    return (
      `⚠️ Виявлено захист або капчу на УЗ — моніторинг #${monitorId} призупинено.\n` +
      `Спробуйте відновити сесію вручну за допомогою команди /list.`
    );
  }

  /**
   * Скидання статусу капчі.
   */
  clearCaptchaStatus(monitorId: number): void {
    this.captchaNotified.delete(monitorId);
  }

  /**
   * Синхронізує cookies з Playwright Context до tough-cookie CookieJar.
   */
  async syncCookiesToJar(playwrightCookies: any[], jar: CookieJar, targetUrl: string): Promise<void> {
    for (const cookie of playwrightCookies) {
      const parts = [
        `${cookie.name}=${cookie.value}`,
        `Domain=${cookie.domain}`,
        `Path=${cookie.path}`
      ];

      if (cookie.expires && cookie.expires !== -1) {
        parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
      }
      if (cookie.httpOnly) parts.push('HttpOnly');
      if (cookie.secure) parts.push('Secure');
      if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);

      const setCookieStr = parts.join('; ');
      await jar.setCookie(setCookieStr, targetUrl);
    }
  }

  /**
   * Оновлення сесії через Playwright (Headless/Headful fallback).
   * Завантажує сторінку УЗ, дозволяє виконати челенджі та зберігає cookies.
   */
  async refreshSession(jar: CookieJar, targetUrl: string, headless: boolean = true, userAgent?: string): Promise<boolean> {
    if (!this.playwrightAvailable) {
      logger.error('Playwright is not available, cannot refresh session');
      return false;
    }

    try {
      const { chromium } = await import('playwright');
      fs.mkdirSync(this.profileDir, { recursive: true });

      const ua = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      logger.info({ headless, userAgent: ua }, 'Launching Playwright context for session refresh...');
      
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: headless,
        channel: 'chrome', // Запускаємо локальний Google Chrome
        viewport: { width: 1280, height: 800 },
        userAgent: ua,
      });

      const page = await context.newPage();
      
      // Налаштування таймауту завантаження
      logger.debug(`Navigating to ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      if (!headless) {
        // Якщо працює в GUI режимі, даємо час на ручну взаємодію / проходження челенджів
        logger.info('Waiting for manual interaction in browser window (60s)...');
        await page.waitForTimeout(60000);
      } else {
        // У headless режимі просто очікуємо завантаження сторінки
        await page.waitForTimeout(5000);
      }

      const cookies = await context.cookies(targetUrl);
      await this.syncCookiesToJar(cookies, jar, targetUrl);
      
      await context.close();
      logger.info('Playwright context closed successfully, cookies synced');
      return true;
    } catch (err) {
      logger.error({ err }, 'Playwright session refresh failed');
      return false;
    }
  }
}

