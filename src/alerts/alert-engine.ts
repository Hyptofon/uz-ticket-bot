// src/alerts/alert-engine.ts
//
// ⚠️ КРИТИЧНИЙ МОДУЛЬ — Alert Engine
// Ізольований модуль, НЕ частина MonitoringWorker.
// Реалізує ТОЧНО логіку розділу 9 ТЗ.
//
// ЗАБОРОНЕНО:
// ❌ editMessageText замість sendMessage
// ❌ disable_notification: true
// ❌ автоматичний completed після першого сповіщення
// ❌ будь-яка дедуплікація повторних сповіщень
//
// Умови зупинки (тільки ці 4):
// 1. Квиток зник (після дебаунсу 2 перевірки)
// 2. Користувач натиснув "🔕 Досить нагадувань" → muted
// 3. Користувач видалив монітор
// 4. Користувач натиснув "✅ Я купив" → completed

import { Bot } from 'grammy';
import { Repository } from '../db/repository';
import { DbMonitor, MonitorSnapshot, AlertStage } from '../db/types';
import { logger } from '../logger';
import {
  currentStage,
  intervalForStage,
  isAlertDue,
  nextAlertTime,
  EscalationStage,
} from './escalation-schedule';
import { buildAlertMessage, buildResolvedMessage, buildUpdateMessage } from '../bot/message-templates';

const DEBOUNCE_NEGATIVE_CHECKS = 2; // кількість поспіль негативних перевірок для підтвердження зникнення

export class AlertEngine {
  constructor(
    private bot: Bot,
    private repo: Repository,
  ) {}

  /**
   * Основний метод — викликається з MonitoringWorker після кожної перевірки.
   * Отримує результат (snapshot) і вирішує, що робити.
   *
   * @param monitor - поточний стан монітора з БД
   * @param snapshot - знімок результату перевірки
   * @param userChatId - chat_id користувача для відправки
   */
  async onCheckResult(
    monitor: DbMonitor,
    snapshot: MonitorSnapshot,
    userChatId: string,
  ): Promise<void> {
    const wasFound = monitor.status === 'found';
    const isFound = snapshot.trains.reduce((sum, t) => sum + t.totalFreeSeats, 0) > 0;

    try {
      if (!wasFound && isFound) {
        // ─── НОВА ХВИЛЯ ВИЯВЛЕННЯ ───
        await this.handleNewlyFound(monitor, snapshot, userChatId);
      } else if (wasFound && isFound) {
        // ─── КВИТОК ВСЕ ЩЕ ДОСТУПНИЙ ───
        await this.handleStillFound(monitor, snapshot, userChatId);
      } else if (wasFound && !isFound) {
        // ─── МОЖЛИВЕ ЗНИКНЕННЯ (дебаунс!) ───
        await this.handlePossiblyGone(monitor, snapshot, userChatId);
      }
      // else: !wasFound && !isFound → тихо, нічого не робити
    } catch (err) {
      logger.error({ err, monitorId: monitor.id }, 'AlertEngine: error processing check result');
    }
  }

  private async handleNewlyFound(
    monitor: DbMonitor,
    snapshot: MonitorSnapshot,
    chatId: string,
  ): Promise<void> {
    logger.info({ monitorId: monitor.id }, 'TICKET FOUND — starting escalation sequence');

    // Оновити статус у БД
    this.repo.markMonitorFound(monitor.id, snapshot);

    // Розрахувати next_alert_at вже після першого повідомлення
    const firstNextAlert = nextAlertTime('escalation1');
    this.repo.updateAfterAlert(monitor.id, firstNextAlert, 'instant');

    // Надіслати INSTANT повідомлення — НОВЕ повідомлення (sendMessage, НЕ edit)
    const text = buildAlertMessage(monitor, snapshot, 'instant', 1);
    await this.sendAlertMessage(chatId, monitor, text, 'instant', snapshot);
  }

  private async handleStillFound(
    monitor: DbMonitor,
    snapshot: MonitorSnapshot,
    chatId: string,
  ): Promise<void> {
    // Скидаємо лічильник негативних перевірок
    this.repo.resetNegativeChecks(monitor.id);

    // Перевірка: чи змінився snapshot суттєво?
    if (this.snapshotChanged(monitor.last_snapshot, snapshot)) {
      logger.info({ monitorId: monitor.id }, 'Snapshot changed — sending update message');
      const text = buildUpdateMessage(monitor, snapshot, monitor.alert_attempt_count + 1);
      await this.sendAlertMessage(chatId, monitor, text, 'update', snapshot);
      this.repo.updateSnapshot(monitor.id, snapshot);
    }

    // Перевірка: чи настав час планового сповіщення?
    if (isAlertDue(monitor.next_alert_at)) {
      const foundAt = monitor.found_at ? new Date(monitor.found_at) : new Date();
      const stage: EscalationStage = currentStage(foundAt);
      const attemptCount = monitor.alert_attempt_count + 1;

      logger.info(
        { monitorId: monitor.id, stage, attempt: attemptCount },
        'Sending scheduled escalation alert',
      );

      const text = buildAlertMessage(monitor, snapshot, stage, attemptCount);
      await this.sendAlertMessage(chatId, monitor, text, stage as AlertStage, snapshot);

      const next = nextAlertTime(stage);
      this.repo.updateAfterAlert(monitor.id, next, stage as AlertStage);
    }
  }

  private async handlePossiblyGone(
    monitor: DbMonitor,
    snapshot: MonitorSnapshot,
    chatId: string,
  ): Promise<void> {
    // Дебаунс: потрібно ДВІЧІ поспіль отримати "немає квитків" перед скиданням
    const negativeCount = this.repo.incrementNegativeChecks(monitor.id);

    logger.debug(
      { monitorId: monitor.id, negativeCount },
      'Negative check registered (debounce)',
    );

    if (negativeCount >= DEBOUNCE_NEGATIVE_CHECKS) {
      // Підтверджено — квиток зник. Повертаємось в active (НЕ completed!)
      logger.info({ monitorId: monitor.id }, 'Ticket confirmed gone — returning to active search');
      this.repo.markMonitorResolved(monitor.id);

      const text = buildResolvedMessage(monitor);
      await this.sendAlertMessage(chatId, monitor, text, 'resolved', undefined);
    }
  }

  /**
   * Перевірка суттєвої зміни snapshot.
   * Суттєва зміна = кількість місць змінилась або з'явився/зник тип вагона.
   */
  private snapshotChanged(lastSnapshotJson: string | null, newSnapshot: MonitorSnapshot): boolean {
    if (!lastSnapshotJson) return false;

    try {
      const last = JSON.parse(lastSnapshotJson) as MonitorSnapshot;

      const lastTotal = last.trains.reduce((s, t) => s + t.totalFreeSeats, 0);
      const newTotal = newSnapshot.trains.reduce((s, t) => s + t.totalFreeSeats, 0);

      if (lastTotal !== newTotal) return true;

      // Перевірка типів вагонів
      const lastTypes = new Set(
        last.trains.flatMap((t) => t.wagons.map((w) => w.type)),
      );
      const newTypes = new Set(
        newSnapshot.trains.flatMap((t) => t.wagons.map((w) => w.type)),
      );

      for (const t of newTypes) {
        if (!lastTypes.has(t)) return true;
      }
      for (const t of lastTypes) {
        if (!newTypes.has(t)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Відправка НОВОГО повідомлення через Telegram.
   * НІКОЛИ не використовується editMessageText.
   * НІКОЛИ не встановлюється disable_notification: true.
   */
  private async sendAlertMessage(
    chatId: string,
    monitor: DbMonitor,
    text: string,
    stage: AlertStage,
    snapshot: MonitorSnapshot | undefined,
  ): Promise<void> {
    const keyboard = this.buildAlertKeyboard(monitor.id);

    try {
      // ⚠️ sendMessage (НІКОЛИ не editMessageText!)
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        // ⚠️ disable_notification НЕ встановлюємо — завжди зі звуком!
      });

      // Зберегти в notification_log
      this.repo.logNotification(monitor.id, stage, text, snapshot);

      logger.info(
        { monitorId: monitor.id, stage, chatId },
        'Alert sent via sendMessage',
      );
    } catch (err: unknown) {
      const error = err as { error_code?: number; parameters?: { retry_after?: number } };

      if (error?.error_code === 429) {
        // Telegram rate limit — зачекати retry_after і повторити
        const retryAfter = error?.parameters?.retry_after ?? 5;
        logger.warn({ retryAfter }, 'Telegram 429 — waiting before retry');
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 500));
        await this.sendAlertMessage(chatId, monitor, text, stage, snapshot);
      } else if (error?.error_code === 403) {
        // Бот заблокований користувачем
        logger.warn({ chatId }, 'Bot blocked by user (403) — marking user inactive');
        const user = this.repo.getUserByChatId(chatId);
        if (user) this.repo.markUserInactive(chatId);
      } else {
        logger.error({ err, monitorId: monitor.id, stage }, 'Failed to send alert message');
      }
    }
  }

  private buildAlertKeyboard(monitorId: number) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Я купив(ла)', callback_data: `bought:${monitorId}` },
          { text: '🔕 Досить нагадувань', callback_data: `mute:${monitorId}` },
        ],
        [
          { text: '🗑 Видалити монітор', callback_data: `delete:${monitorId}` },
        ],
      ],
    };
  }
}
