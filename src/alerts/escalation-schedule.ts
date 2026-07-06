// src/alerts/escalation-schedule.ts
// Чисті функції для розрахунку стадій ескалації Alert Engine.
// Всі числа — з ConfigService, не хардкод.

import { config } from '../config';

export type EscalationStage = 'escalation1' | 'escalation2' | 'steady';

/**
 * Визначає поточну стадію ескалації на основі часу першого виявлення квитка.
 * @param foundAt - момент першого виявлення поточної «хвилі»
 * @returns стадія ескалації
 */
export function currentStage(foundAt: Date): EscalationStage {
  const elapsedSec = (Date.now() - foundAt.getTime()) / 1000;

  if (elapsedSec < config.alerts.escalation1DurationSec) {
    return 'escalation1';
  }
  if (elapsedSec < config.alerts.escalation1DurationSec + config.alerts.escalation2DurationSec) {
    return 'escalation2';
  }
  return 'steady';
}

/**
 * Повертає інтервал у секундах для заданої стадії.
 */
export function intervalForStage(stage: EscalationStage): number {
  switch (stage) {
    case 'escalation1':
      return config.alerts.escalation1IntervalSec;
    case 'escalation2':
      return config.alerts.escalation2IntervalSec;
    case 'steady':
      return config.alerts.steadyIntervalSec;
  }
}

/**
 * Розраховує час наступного сповіщення.
 */
export function nextAlertTime(stage: EscalationStage): Date {
  return new Date(Date.now() + intervalForStage(stage) * 1000);
}

/**
 * Перевірка: чи настав час для наступного сповіщення.
 */
export function isAlertDue(nextAlertAt: Date | null | string): boolean {
  if (!nextAlertAt) return false;
  const t = typeof nextAlertAt === 'string' ? new Date(nextAlertAt) : nextAlertAt;
  return Date.now() >= t.getTime();
}
