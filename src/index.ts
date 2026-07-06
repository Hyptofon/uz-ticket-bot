// src/index.ts
// Точка входу — ініціалізація всіх модулів і запуск

import { config } from './config';
import { logger } from './logger';
import { Repository, getRepository } from './db/repository';
import { UzApiClient } from './uz-client/uz-api-client';
import { createBot } from './bot/bot';
import { MonitoringWorker } from './worker/monitoring-worker';

// Встановити timezone
process.env.TZ = config.timezone;

async function main(): Promise<void> {
  logger.info('🚀 UZ TicketWatcher starting...');

  // Ініціалізація Repository (створить БД якщо немає)
  const repo: Repository = getRepository();
  logger.info('✅ Database initialized');

  // Ініціалізація УЗ API клієнта
  const uzClient = new UzApiClient();
  logger.info('✅ UZ API client initialized');

  // Ініціалізація Telegram бота
  const bot = createBot(repo, uzClient);
  logger.info('✅ Telegram bot created');

  // Ініціалізація MonitoringWorker
  const worker = new MonitoringWorker(bot, repo, uzClient);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully...');
    worker.stop();
    await bot.stop();
    repo.close();
    logger.info('Bye! 👋');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    // Продовжуємо роботу — не падаємо
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });

  // Запустити Worker (відновить моніторинги з БД)
  worker.start();
  logger.info('✅ MonitoringWorker started');

  // Запустити бота (long polling — не потрібен HTTPS)
  logger.info('✅ Starting Telegram long polling...');
  logger.info(
    {
      allowedChatIds: config.telegram.allowedChatIds,
      pollInterval: config.polling.intervalSec,
    },
    '🎫 UZ TicketWatcher is ready!',
  );

  // Запустити бота — блокує до зупинки
  await bot.start({
    onStart: (info) => {
      logger.info({ botUsername: info.username }, `Bot @${info.username} is running!`);
      console.log(`\n🎫 Bot @${info.username} is running!`);
      console.log(`📱 Allowed chat IDs: ${config.telegram.allowedChatIds.join(', ')}`);
      console.log(`⏱  Poll interval: ${config.polling.intervalSec}s`);
      console.log(`\nSend /start to your bot to begin!\n`);
    },
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
