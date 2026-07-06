// src/bot/message-templates.ts
// Шаблони повідомлень для Alert Engine та бота
// Кожне повідомлення унікальне (номер спроби + час)

import { DbMonitor, MonitorSnapshot, AlertStage } from '../db/types';
import { EscalationStage } from '../alerts/escalation-schedule';

function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Kyiv',
  });
}

function formatDate(dateStr: string): string {
  // YYYY-MM-DD → DD.MM.YYYY
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function stageEmoji(stage: string): string {
  const map: Record<string, string> = {
    instant: '🚨',
    escalation1: '🔥',
    escalation2: '🔔',
    steady: '🔁',
    update: '📊',
    resolved: 'ℹ️',
  };
  return map[stage] ?? '🔔';
}

function formatWagons(snapshot: MonitorSnapshot): string {
  if (!snapshot.trains || snapshot.trains.length === 0) {
    return 'Місця: немає даних';
  }

  const lines: string[] = [];
  for (const train of snapshot.trains) {
    if (train.wagons.length === 0) continue;

    // Групуємо за типом вагона
    const typeGroups = new Map<string, { freeSeats: number; price: number }>();
    for (const wagon of train.wagons) {
      const existing = typeGroups.get(wagon.type);
      if (existing) {
        existing.freeSeats += wagon.freeSeats;
        existing.price = Math.min(existing.price, wagon.price); // мінімальна ціна
      } else {
        typeGroups.set(wagon.type, { freeSeats: wagon.freeSeats, price: wagon.price });
      }
    }

    for (const [type, info] of typeGroups) {
      const priceStr = info.price > 0 ? ` · від ${info.price} грн` : '';
      lines.push(`${type}: ${info.freeSeats} місць${priceStr}`);
    }
  }

  return lines.join('\n') || 'Місця: завантажуються...';
}

function monitorTitle(monitor: DbMonitor): string {
  const trainStr = monitor.train_number ? ` №${monitor.train_number}` : '';
  return `Поїзд${trainStr}: ${monitor.from_station_name} — ${monitor.to_station_name}, ${formatDate(monitor.travel_date)}`;
}

/** Instant або Escalation/Steady повідомлення */
export function buildAlertMessage(
  monitor: DbMonitor,
  snapshot: MonitorSnapshot,
  stage: EscalationStage | AlertStage,
  attemptCount: number,
): string {
  const emoji = stageEmoji(stage);
  const time = formatTime();
  const wagonsInfo = formatWagons(snapshot);
  const title = monitorTitle(monitor);
  const url = 'https://booking.uz.gov.ua/';

  if (stage === 'instant') {
    return (
      `${emoji} <b>Знайдено квиток!</b>\n` +
      `${title}\n\n` +
      `${wagonsInfo}\n\n` +
      `🔗 ${url}\n` +
      `⏰ ${time} (спроба #${attemptCount})`
    );
  }

  const stageLabel = stage === 'escalation1' ? 'Escalation I' :
                     stage === 'escalation2' ? 'Escalation II' :
                     'Steady';

  return (
    `${emoji} <b>Квиток ще доступний</b> (спроба #${attemptCount}, ${time})\n` +
    `${title}\n\n` +
    `${wagonsInfo}\n\n` +
    `🔗 ${url}`
  );
}

/** Повідомлення про зміну snapshot (позапланове) */
export function buildUpdateMessage(
  monitor: DbMonitor,
  snapshot: MonitorSnapshot,
  attemptCount: number,
): string {
  const time = formatTime();
  const wagonsInfo = formatWagons(snapshot);
  const title = monitorTitle(monitor);

  return (
    `📊 <b>Кількість місць змінилась!</b> (${time})\n` +
    `${title}\n\n` +
    `${wagonsInfo}\n\n` +
    `🔗 https://booking.uz.gov.ua/\n` +
    `<i>Спроба #${attemptCount}</i>`
  );
}

/** Повідомлення про зникнення квитка (resolved) */
export function buildResolvedMessage(monitor: DbMonitor): string {
  const trainStr = monitor.train_number ? ` №${monitor.train_number}` : '';
  return (
    `ℹ️ Квиток зник із продажу.\n` +
    `Монітор (${monitor.from_station_name}—${monitor.to_station_name}${trainStr}, ${formatDate(monitor.travel_date)}) продовжує шукати далі.`
  );
}

/** Картка монітора для /list */
export function buildMonitorCard(monitor: DbMonitor): string {
  const statusMap: Record<string, string> = {
    active: '🟢 Шукаю',
    paused: '⏸ На паузі',
    found: '🔔 ЗНАЙДЕНО',
    muted: '🔕 Приглушено (квиток ще є)',
    error: '⚠️ Проблема з доступом',
    completed: '✅ Завершено',
    expired: '⌛ Минула дата',
  };

  const trainStr = monitor.train_number ? ` №${monitor.train_number}` : '';
  const wagonTypes = monitor.wagon_types
    ? (JSON.parse(monitor.wagon_types) as string[]).join(', ')
    : 'будь-який';

  return (
    `<b>${statusMap[monitor.status] ?? monitor.status}</b>\n` +
    `🗺 ${monitor.from_station_name} → ${monitor.to_station_name}\n` +
    `📅 ${formatDate(monitor.travel_date)}\n` +
    `🚂 Поїзд${trainStr}\n` +
    `💺 Вагон: ${wagonTypes}\n` +
    `🔍 ID: #${monitor.id}`
  );
}

/** Вітальне повідомлення /start */
export function buildWelcomeMessage(): string {
  return (
    `👋 <b>UZ TicketWatcher</b>\n\n` +
    `Я слідкую за появою квитків на booking.uz.gov.ua і сповіщаю тебе, щойно вони з'являються.\n\n` +
    `При знайденому квитку — надсилаю повідомлення кілька разів поспіль, щоб ти точно не пропустив 🚨\n\n` +
    `<b>Команди:</b>\n` +
    `➕ /track — додати новий монітор\n` +
    `📋 /list — мої монітори\n` +
    `❓ /help — довідка`
  );
}

/** Повідомлення про помилку (загальне) */
export function buildErrorMessage(monitorId: number, details: string): string {
  return (
    `⚠️ <b>Монітор #${monitorId} — помилка доступу до УЗ</b>\n\n` +
    `${details}\n\n` +
    `Монітор тимчасово зупинено. Використай /list → ▶️ Відновити коли ситуація зміниться.`
  );
}
