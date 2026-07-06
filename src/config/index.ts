// src/config/index.ts
// ConfigService — єдина точка читання .env
// Жодних магічних чисел в іншому коді — тільки через цей модуль

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) return defaultValue;
  const num = parseInt(val, 10);
  if (isNaN(num)) throw new Error(`Environment variable ${name} must be an integer, got: ${val}`);
  return num;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const val = process.env[name];
  if (!val) return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: requireEnv('ALLOWED_CHAT_IDS')
      .split(',')
      .map((id) => id.trim()),
  },

  database: {
    path: optionalEnv('DATABASE_PATH', './data/bot.db'),
  },

  uz: {
    baseUrl: optionalEnv('UZ_BASE_URL', 'https://booking.uz.gov.ua'),
  },

  polling: {
    intervalSec: optionalInt('POLL_INTERVAL_SEC', 90),
    workerTickSec: optionalInt('WORKER_TICK_SEC', 5),
    // Нічне уповільнення — тільки для status=active, НЕ для found!
    nightThrottleEnabled: optionalBool('NIGHT_THROTTLE_ENABLED', true),
    nightThrottleStart: optionalEnv('NIGHT_THROTTLE_START', '01:00'),
    nightThrottleEnd: optionalEnv('NIGHT_THROTTLE_END', '05:00'),
    nightThrottleIntervalSec: optionalInt('NIGHT_THROTTLE_INTERVAL_SEC', 600),
    // Глобальний rate-limit між запитами до УЗ API (мс)
    globalRequestMinIntervalMs: optionalInt('GLOBAL_REQUEST_MIN_INTERVAL_MS', 1000),
    maxConsecutiveFailures: optionalInt('MAX_CONSECUTIVE_FAILURES', 10),
  },

  // Alert Engine — всі числа з конфігурації, НЕ хардкод
  alerts: {
    instantDelaySec: optionalInt('ALERT_INSTANT_DELAY_SEC', 0),
    // Фаза 1: кожні 6 сек протягом 5 хвилин (~50 повідомлень) 🚨
    escalation1IntervalSec: optionalInt('ALERT_ESCALATION1_INTERVAL_SEC', 6),
    escalation1DurationSec: optionalInt('ALERT_ESCALATION1_DURATION_SEC', 300),
    // Фаза 2: кожні 30 сек протягом 10 хвилин 🔔
    escalation2IntervalSec: optionalInt('ALERT_ESCALATION2_INTERVAL_SEC', 30),
    escalation2DurationSec: optionalInt('ALERT_ESCALATION2_DURATION_SEC', 600),
    // Стабільна фаза: кожні 2 хвилини 🔁
    steadyIntervalSec: optionalInt('ALERT_STEADY_INTERVAL_SEC', 120),
    nightQuietEnabled: optionalBool('ALERT_NIGHT_QUIET_ENABLED', false),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },

  timezone: optionalEnv('TZ', 'Europe/Kyiv'),
} as const;

export type Config = typeof config;
