// src/worker/monitoring-worker.ts
//
// MonitoringWorker — фоновий цикл полінгу
//
// Відповідальність:
// - Читає активні монітори з БД кожні WORKER_TICK_SEC секунд
// - Перевіряє, чи настав час чергової перевірки (last_checked_at + interval <= now)
// - Перевіряє, чи настав час Alert Engine (next_alert_at <= now)
// - ДВІ незалежні шкали часу — перевірка API і розсилка сповіщень не заважають одна одній
// - Глобальний rate-limiter (не більше 1 запиту/сек до УЗ)
// - Нічне уповільнення (01:00–05:00) — ТІЛЬКИ для status=active, НЕ для found!
// - При старті: відновлює всі active/found/muted монітори з БД

import { Bot } from 'grammy';
import { config } from '../config';
import { Repository } from '../db/repository';
import { UzApiClient, CaptchaDetectedError } from '../uz-client/uz-api-client';
import { UzSessionManager } from '../uz-client/uz-session-manager';
import { AlertEngine } from '../alerts/alert-engine';
import { logger } from '../logger';
import { DbMonitor } from '../db/types';
import { isAlertDue } from '../alerts/escalation-schedule';
import { buildErrorMessage } from '../bot/message-templates';

export class MonitoringWorker {
  private isRunning = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private sessionManager: UzSessionManager;
  private alertEngine: AlertEngine;
  private captchaResetTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private bot: Bot,
    private repo: Repository,
    private uzClient: UzApiClient,
  ) {
    this.sessionManager = new UzSessionManager();
    this.alertEngine = new AlertEngine(bot, repo);
  }

  /** Запустити Worker */
  start(): void {
    if (this.isRunning) {
      logger.warn('MonitoringWorker already running');
      return;
    }

    this.isRunning = true;
    logger.info(
      {
        tickSec: config.polling.workerTickSec,
        pollIntervalSec: config.polling.intervalSec,
      },
      'MonitoringWorker started',
    );

    this.scheduleTick();
  }

  /** Зупинити Worker */
  stop(): void {
    this.isRunning = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info('MonitoringWorker stopped');
  }

  private scheduleTick(): void {
    if (!this.isRunning) return;
    this.tickTimer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, 'Worker tick error');
      } finally {
        this.scheduleTick();
      }
    }, config.polling.workerTickSec * 1000);
  }

  private async tick(): Promise<void> {
    // Отримати всі активні монітори
    const monitors = this.repo.getWorkableMonitors();
    if (monitors.length === 0) return;

    const now = new Date();

    for (const monitor of monitors) {
      // ── ПЕРЕВІРКА 1: чи потрібно перевіряти API (poll) ──
      const pollIntervalSec = this.getPollInterval(monitor, now);
      const lastCheckedAt = monitor.last_checked_at ? new Date(monitor.last_checked_at) : null;
      const isDuePoll =
        !lastCheckedAt ||
        (now.getTime() - lastCheckedAt.getTime()) / 1000 >= pollIntervalSec;

      // ── ПЕРЕВІРКА 2: чи настав час Alert Engine ──
      const isDueAlert =
        monitor.status === 'found' && isAlertDue(monitor.next_alert_at);

      if (!isDuePoll && !isDueAlert) continue;

      if (isDuePoll) {
        await this.pollMonitor(monitor);
      } else if (isDueAlert) {
        // Якщо не час для poll, але час для alert — надіслати планове сповіщення
        // Це відбувається, коли Alert Engine таймер спрацьовує між poll-ами
        await this.triggerScheduledAlert(monitor);
      }
    }
  }

  /** Визначити інтервал перевірки з урахуванням нічного режиму */
  private getPollInterval(monitor: DbMonitor, now: Date): number {
    // Нічне уповільнення — ТІЛЬКИ для active (не found, не muted)
    if (
      monitor.status === 'active' &&
      config.polling.nightThrottleEnabled &&
      this.isNightTime(now)
    ) {
      return config.polling.nightThrottleIntervalSec;
    }
    return config.polling.intervalSec;
  }

  private isNightTime(now: Date): boolean {
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const current = hours * 60 + minutes;

    const [startH, startM] = config.polling.nightThrottleStart.split(':').map(Number);
    const [endH, endM] = config.polling.nightThrottleEnd.split(':').map(Number);
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;

    if (start <= end) {
      return current >= start && current < end;
    }
    // Перетин північ (напр. 23:00–05:00)
    return current >= start || current < end;
  }

  /** Виконати перевірку API для монітора */
  private async pollMonitor(monitor: DbMonitor): Promise<void> {
    logger.debug(
      { monitorId: monitor.id, status: monitor.status },
      'Polling monitor',
    );

    try {
      // Отримати snapshot від УЗ API
      const snapshot = await this.uzClient.getAvailabilitySnapshot(
        monitor.from_station_id,
        monitor.to_station_id,
        monitor.travel_date,
        monitor.from_station_name,
        monitor.to_station_name,
        monitor.train_number,
        monitor.wagon_types ? JSON.parse(monitor.wagon_types) as string[] : null,
        monitor.seat_position,
      );

      // Успішна перевірка — скидаємо лічильник збоїв
      this.repo.updateAfterCheck(monitor.id, true);

      // Скидаємо captcha статус
      this.sessionManager.clearCaptchaStatus(monitor.id);

      // Отримати chat_id користувача для сповіщень
      const chatId = this.getChatIdForMonitor(monitor);
      if (!chatId) return;

      // Передати в AlertEngine
      await this.alertEngine.onCheckResult(monitor, snapshot, chatId);
    } catch (err) {
      if (err instanceof CaptchaDetectedError) {
        await this.handleCaptcha(monitor);
      } else {
        await this.handlePollError(monitor, err);
      }
    }
  }

  /** Запланований alert (між poll-ами, коли next_alert_at < now) */
  private async triggerScheduledAlert(monitor: DbMonitor): Promise<void> {
    if (!monitor.last_snapshot) return;

    try {
      const snapshot = JSON.parse(monitor.last_snapshot);
      const chatId = this.getChatIdForMonitor(monitor);
      if (!chatId) return;

      await this.alertEngine.onCheckResult(monitor, snapshot, chatId);
    } catch (err) {
      logger.error({ err, monitorId: monitor.id }, 'Failed to trigger scheduled alert');
    }
  }

  private getChatIdForMonitor(monitor: DbMonitor): string | null {
    // Для персонального бота — перший дозволений chat_id (один користувач)
    // При необхідності можна розширити: додати метод getUserById в Repository
    const allowed = config.telegram.allowedChatIds;
    if (allowed.length > 0) {
      // Перевіряємо чи є у користувача цей монітор
      for (const chatId of allowed) {
        const user = this.repo.getUserByChatId(chatId);
        if (user && user.id === monitor.user_id) {
          return chatId;
        }
      }
      // Fallback: перший дозволений chat_id
      return allowed[0];
    }
    return null;
  }

  private async handleCaptcha(monitor: DbMonitor): Promise<void> {
    this.repo.updateAfterCheck(monitor.id, false);
    logger.warn({ monitorId: monitor.id }, 'CAPTCHA detected. Initiating automated session recovery...');

    const chatId = this.getChatIdForMonitor(monitor);

    // Крок 1. Спроба автоматичного відновлення в headless режимі
    const headlessSuccess = await this.sessionManager.refreshSession(
      this.uzClient.getCookieJar(),
      config.uz.baseUrl,
      true,
      this.uzClient.getUserAgent()
    );

    if (headlessSuccess) {
      logger.info({ monitorId: monitor.id }, 'Headless session recovery succeeded');
      this.uzClient.setSessionInitialized(true);
      this.sessionManager.clearCaptchaStatus(monitor.id);
      return;
    }

    // Крок 2. Якщо headless не впорався — повідомляємо користувача та пропонуємо ручне відновлення (headful)
    logger.warn({ monitorId: monitor.id }, 'Headless recovery failed. Falling back to headful...');
    
    const msg = this.sessionManager.handleCaptchaDetected(monitor.id);
    if (msg && chatId) {
      try {
        await this.bot.api.sendMessage(chatId, msg + '\n\n🔧 Запускаю вікно браузера для ручного вирішення...');
      } catch (err) {
        logger.error({ err }, 'Failed to send captcha alert to Telegram');
      }
    }

    // Запускаємо headful режим для вирішення користувачем
    const headfulSuccess = await this.sessionManager.refreshSession(
      this.uzClient.getCookieJar(),
      config.uz.baseUrl,
      false,
      this.uzClient.getUserAgent()
    );

    if (headfulSuccess) {
      logger.info({ monitorId: monitor.id }, 'Headful session recovery succeeded');
      this.uzClient.setSessionInitialized(true);
      this.sessionManager.clearCaptchaStatus(monitor.id);
      if (chatId) {
        try {
          await this.bot.api.sendMessage(chatId, '✅ Сесію успішно відновлено! Моніторинг продовжується.');
        } catch {}
      }
    } else {
      logger.error({ monitorId: monitor.id }, 'Both headless and headful session recovery failed');
      
      // Заплануємо наступну спробу через 10 хвилин
      const existing = this.captchaResetTimers.get(monitor.id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        this.captchaResetTimers.delete(monitor.id);
        this.sessionManager.clearCaptchaStatus(monitor.id);
        logger.info({ monitorId: monitor.id }, 'Retrying automated session recovery after timeout...');
      }, 10 * 60 * 1000);

      this.captchaResetTimers.set(monitor.id, timer);
    }
  }

  private async handlePollError(monitor: DbMonitor, err: unknown): Promise<void> {
    this.repo.updateAfterCheck(monitor.id, false);

    const updatedMonitor = this.repo.getMonitorById(monitor.id);
    const failures = updatedMonitor?.consecutive_failures ?? 0;

    logger.warn(
      { monitorId: monitor.id, failures, err: String(err) },
      'Monitor poll failed',
    );

    if (failures >= config.polling.maxConsecutiveFailures) {
      // Переходимо в статус error
      this.repo.updateMonitorStatus(monitor.id, 'error');

      const chatId = this.getChatIdForMonitor(monitor);
      if (chatId) {
        const errorMsg = buildErrorMessage(
          monitor.id,
          `${failures} невдалих перевірок поспіль.\nОстання помилка: ${String(err).slice(0, 200)}`,
        );
        try {
          await this.bot.api.sendMessage(chatId, errorMsg, { parse_mode: 'HTML' });
        } catch {
          logger.error({ monitorId: monitor.id }, 'Failed to send error notification');
        }
      }

      logger.error({ monitorId: monitor.id, failures }, 'Monitor set to error status');
    }
  }
}
