// tests/alert-engine.test.ts
// Unit-тести для Alert Engine — перевірка стадій ескалації та переходів статусів

import { currentStage, intervalForStage, isAlertDue, nextAlertTime } from '../src/alerts/escalation-schedule';

// Мокаємо config, щоб контролювати інтервали
jest.mock('../src/config', () => ({
  config: {
    alerts: {
      instantDelaySec: 0,
      escalation1IntervalSec: 25,
      escalation1DurationSec: 300,   // 5 хвилин
      escalation2IntervalSec: 60,
      escalation2DurationSec: 1500,  // 25 хвилин
      steadyIntervalSec: 300,
      nightQuietEnabled: false,
    },
    logging: { level: 'silent' },
    telegram: { botToken: 'test', allowedChatIds: ['123'] },
    database: { path: ':memory:' },
    uz: { baseUrl: 'https://booking.uz.gov.ua' },
    polling: {
      intervalSec: 90,
      workerTickSec: 5,
      nightThrottleEnabled: false,
      nightThrottleStart: '01:00',
      nightThrottleEnd: '05:00',
      nightThrottleIntervalSec: 600,
      globalRequestMinIntervalMs: 1000,
      maxConsecutiveFailures: 10,
    },
    timezone: 'Europe/Kyiv',
  },
}));

describe('EscalationSchedule', () => {
  describe('currentStage', () => {
    it('returns escalation1 when within first 5 minutes', () => {
      const foundAt = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago
      expect(currentStage(foundAt)).toBe('escalation1');
    });

    it('returns escalation2 when between 5 and 30 minutes', () => {
      const foundAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      expect(currentStage(foundAt)).toBe('escalation2');
    });

    it('returns steady when more than 30 minutes', () => {
      const foundAt = new Date(Date.now() - 35 * 60 * 1000); // 35 minutes ago
      expect(currentStage(foundAt)).toBe('steady');
    });

    it('returns escalation1 at exactly t=0', () => {
      const foundAt = new Date(); // just now
      expect(currentStage(foundAt)).toBe('escalation1');
    });

    it('returns escalation2 at exactly 5 minutes', () => {
      const foundAt = new Date(Date.now() - 300 * 1000); // exactly 5 min
      expect(currentStage(foundAt)).toBe('escalation2');
    });

    it('returns steady at exactly 30 minutes', () => {
      const foundAt = new Date(Date.now() - (300 + 1500) * 1000); // 30 min
      expect(currentStage(foundAt)).toBe('steady');
    });
  });

  describe('intervalForStage', () => {
    it('escalation1 returns 25 seconds', () => {
      expect(intervalForStage('escalation1')).toBe(25);
    });

    it('escalation2 returns 60 seconds', () => {
      expect(intervalForStage('escalation2')).toBe(60);
    });

    it('steady returns 300 seconds', () => {
      expect(intervalForStage('steady')).toBe(300);
    });
  });

  describe('isAlertDue', () => {
    it('returns true when next_alert_at is in the past', () => {
      const past = new Date(Date.now() - 1000);
      expect(isAlertDue(past)).toBe(true);
    });

    it('returns false when next_alert_at is in the future', () => {
      const future = new Date(Date.now() + 60000);
      expect(isAlertDue(future)).toBe(false);
    });

    it('returns false when next_alert_at is null', () => {
      expect(isAlertDue(null)).toBe(false);
    });

    it('handles string dates correctly', () => {
      const past = new Date(Date.now() - 5000).toISOString();
      expect(isAlertDue(past)).toBe(true);
    });
  });

  describe('nextAlertTime', () => {
    it('returns a date in the future for all stages', () => {
      const now = Date.now();
      expect(nextAlertTime('escalation1').getTime()).toBeGreaterThan(now);
      expect(nextAlertTime('escalation2').getTime()).toBeGreaterThan(now);
      expect(nextAlertTime('steady').getTime()).toBeGreaterThan(now);
    });

    it('returns correct interval for escalation1', () => {
      const before = Date.now();
      const next = nextAlertTime('escalation1').getTime();
      expect(next - before).toBeGreaterThanOrEqual(25 * 1000 - 50); // 25s with small tolerance
      expect(next - before).toBeLessThanOrEqual(25 * 1000 + 100);
    });
  });
});
