// src/bot/bot.ts
// BotHandler — Telegram бот, команди, inline-кнопки, whitelist middleware
// НЕ звертається до БД напряму — тільки через Repository

import { Bot, Context } from 'grammy';
import { config } from '../config';
import { Repository } from '../db/repository';
import { UzApiClient } from '../uz-client/uz-api-client';
import { AlertEngine } from '../alerts/alert-engine';
import { MonitorFsm } from './fsm';
import { logger } from '../logger';
import { mainMenuKeyboard, monitorCardKeyboard } from './keyboards';
import {
  buildWelcomeMessage,
  buildMonitorCard,
  buildErrorMessage,
} from './message-templates';

export function createBot(repo: Repository, uzClient: UzApiClient): Bot {
  const bot = new Bot(config.telegram.botToken);
  const alertEngine = new AlertEngine(bot, repo);
  const fsm = new MonitorFsm(repo, uzClient);

  // ─── Whitelist Middleware ───
  // Бот ігнорує всіх крім дозволених chat_id (безпека, розділ 14)
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    if (!chatId) return;

    // Дозволити тільки якщо в ALLOWED_CHAT_IDS або є в БД з is_whitelisted=1
    const isAllowed =
      config.telegram.allowedChatIds.includes(chatId) ||
      repo.isUserWhitelisted(chatId);

    if (!isAllowed) {
      logger.warn({ chatId }, 'Unauthorized access attempt — ignoring');
      // Тихо ігноруємо — не відповідаємо, щоб не підтверджувати існування бота
      return;
    }

    // Upsert user (зареєструвати якщо новий)
    const username = ctx.from?.username;
    try {
      repo.upsertUser(chatId, username);
    } catch {
      // Якщо помилка при першому запиті — це новий chat_id якого немає в allowed
    }

    await next();
  });

  // ─── /start ───
  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info({ chatId }, '/start command');

    // При першому запуску — вивести chat_id в консоль (для налаштування)
    console.log(`[START] Chat ID: ${chatId} — add to ALLOWED_CHAT_IDS if needed`);

    await ctx.reply(buildWelcomeMessage(), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
  });

  // ─── /track ───
  bot.command('track', async (ctx) => {
    await fsm.startTrack(ctx);
  });

  // ─── /stop ───
  bot.command('stop', async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // 1. Очищуємо стан діалогу (якщо користувач був у процесі додавання)
    repo.clearDialogState(chatId);
    
    // 2. Ставимо на паузу всі активні монітори цього користувача
    const monitors = repo.getMonitorsByUserChatId(chatId);
    let pausedCount = 0;
    
    for (const monitor of monitors) {
      if (monitor.status === 'active' || monitor.status === 'found') {
        repo.updateMonitorStatus(monitor.id, 'paused');
        pausedCount++;
      }
    }
    
    logger.info({ chatId, pausedCount }, '/stop command executed');
    
    await ctx.reply(
      `🛑 <b>Бот зупинено.</b>\n\n` +
      `Процес створення нового монітора скасовано.\n` +
      `Активних моніторів поставлено на паузу: <b>${pausedCount}</b>.\n\n` +
      `Щоб відновити моніторинг, використай /list та натисни "▶️ Відновити" на потрібних маршрутах.`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
    );
  });

  // ─── /list ───
  bot.command('list', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const monitors = repo.getMonitorsByUserChatId(chatId);

    if (monitors.length === 0) {
      await ctx.reply(
        '📋 У тебе поки немає активних моніторів.\n\nНатисни /track або кнопку нижче, щоб додати:',
        { reply_markup: mainMenuKeyboard() },
      );
      return;
    }

    for (const monitor of monitors) {
      await ctx.reply(buildMonitorCard(monitor), {
        parse_mode: 'HTML',
        reply_markup: monitorCardKeyboard(monitor),
      });
    }
  });

  // ─── /help ───
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `❓ <b>Довідка UZ TicketWatcher</b>\n\n` +
      `<b>Як це працює:</b>\n` +
      `1. Додай монітор через /track\n` +
      `2. Бот у фоні перевіряє наявність квитків\n` +
      `3. При знаходженні — надсилає повідомлення кілька разів:\n` +
      `   • Одразу (🚨 Instant)\n` +
      `   • Кожні 25 сек протягом 5 хвилин (🔥)\n` +
      `   • Кожну хвилину протягом 30 хвилин (🔔)\n` +
      `   • Кожні 5 хвилин до реакції (🔁)\n\n` +
      `<b>Команди:</b>\n` +
      `/track — додати монітор\n` +
      `/list — всі монітори\n\n` +
      `<b>Кнопки на картці монітора:</b>\n` +
      `⏸ Пауза — зупинити перевірку\n` +
      `▶️ Відновити — відновити перевірку\n` +
      `✅ Я купив(ла) — монітор завершено\n` +
      `🔕 Досить нагадувань — зупинити сповіщення (моніторинг триває)\n` +
      `🗑 Видалити — видалити монітор`,
      { parse_mode: 'HTML' },
    );
  });

  // ─── /stats ───
  bot.command('stats', async (ctx) => {
    const os = require('os');
    const uptimeSec = process.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);

    const memUsage = process.memoryUsage();
    const rssMb = (memUsage.rss / 1024 / 1024).toFixed(2);
    
    const activeMonitors = repo.getWorkableMonitors();
    
    // Знайти час останньої перевірки (максимальний last_checked_at серед усіх моніторів)
    let lastChecked: Date | null = null;
    const allMonitors = repo.getMonitorsByUserChatId(String(ctx.chat.id));
    for (const m of allMonitors) {
      if (m.last_checked_at) {
        const d = new Date(m.last_checked_at);
        if (!lastChecked || d > lastChecked) lastChecked = d;
      }
    }
    
    const lastCheckedStr = lastChecked 
      ? lastChecked.toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' }) 
      : 'ніколи';

    await ctx.reply(
      `📊 <b>Статистика системи</b>\n\n` +
      `🟢 <b>Uptime:</b> ${days}д ${hours}г ${minutes}хв\n` +
      `🧠 <b>RAM (Бот):</b> ${rssMb} MB\n` +
      `🚂 <b>Активних моніторів:</b> ${activeMonitors.length}\n` +
      `🕒 <b>Останній пінг УЗ:</b> ${lastCheckedStr}\n\n` +
      `<i>Все працює як швейцарський годинник 🇨🇭</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── Inline callback handlers ───
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = String(ctx.chat!.id);

    logger.debug({ data, chatId }, 'Callback query');

    // Меню
    if (data === 'menu:track') {
      await fsm.startTrack(ctx);
      return;
    }
    if (data === 'menu:list') {
      await ctx.answerCallbackQuery();
      // Перенаправити на команду /list логіку
      const monitors = repo.getMonitorsByUserChatId(chatId);
      if (monitors.length === 0) {
        await ctx.reply('📋 Моніторів поки немає. Натисни /track щоб додати.');
        return;
      }
      for (const monitor of monitors) {
        await ctx.reply(buildMonitorCard(monitor), {
          parse_mode: 'HTML',
          reply_markup: monitorCardKeyboard(monitor),
        });
      }
      return;
    }

    // Підтвердження збереження (force — дублікат)
    if (data === 'confirm:force_save') {
      await ctx.answerCallbackQuery();
      await fsm.handleForceSave(ctx);
      return;
    }

    // Monitor actions
    const pauseMatch = data.match(/^pause:(\d+)$/);
    if (pauseMatch) {
      await ctx.answerCallbackQuery('⏸ Монітор поставлено на паузу');
      const id = parseInt(pauseMatch[1]);
      repo.updateMonitorStatus(id, 'paused');
      const monitor = repo.getMonitorById(id);
      if (monitor) {
        await ctx.editMessageText(buildMonitorCard(monitor), {
          parse_mode: 'HTML',
          reply_markup: monitorCardKeyboard(monitor),
        });
      }
      return;
    }

    const resumeMatch = data.match(/^resume:(\d+)$/);
    if (resumeMatch) {
      await ctx.answerCallbackQuery('▶️ Монітор відновлено');
      const id = parseInt(resumeMatch[1]);
      repo.updateMonitorStatus(id, 'active');
      const monitor = repo.getMonitorById(id);
      if (monitor) {
        await ctx.editMessageText(buildMonitorCard(monitor), {
          parse_mode: 'HTML',
          reply_markup: monitorCardKeyboard(monitor),
        });
      }
      return;
    }

    const muteMatch = data.match(/^mute:(\d+)$/);
    if (muteMatch) {
      await ctx.answerCallbackQuery('🔕 Нагадування зупинено. Моніторинг триває.');
      const id = parseInt(muteMatch[1]);
      repo.updateMonitorStatus(id, 'muted');
      const monitor = repo.getMonitorById(id);
      if (monitor) {
        await ctx.editMessageText(buildMonitorCard(monitor), {
          parse_mode: 'HTML',
          reply_markup: monitorCardKeyboard(monitor),
        });
      }
      return;
    }

    const boughtMatch = data.match(/^bought:(\d+)$/);
    if (boughtMatch) {
      await ctx.answerCallbackQuery('✅ Вітаємо з покупкою квитка! 🎉');
      const id = parseInt(boughtMatch[1]);
      repo.updateMonitorStatus(id, 'completed');
      const monitor = repo.getMonitorById(id);
      if (monitor) {
        await ctx.editMessageText(buildMonitorCard(monitor), {
          parse_mode: 'HTML',
          reply_markup: monitorCardKeyboard(monitor),
        });
      }
      logger.info({ monitorId: id, chatId }, 'Monitor marked as bought/completed');
      return;
    }

    const deleteMatch = data.match(/^delete:(\d+)$/);
    if (deleteMatch) {
      await ctx.answerCallbackQuery('🗑 Монітор видалено');
      const id = parseInt(deleteMatch[1]);
      repo.deleteMonitor(id);
      await ctx.editMessageText(`🗑 Монітор #${id} видалено.`);
      return;
    }

    const updateMonitorMatch = data.match(/^update_monitor:(\d+)$/);
    if (updateMonitorMatch) {
      await ctx.answerCallbackQuery();
      const id = parseInt(updateMonitorMatch[1]);
      repo.updateMonitorStatus(id, 'active');
      const monitor = repo.getMonitorById(id);
      await ctx.reply(
        monitor
          ? `✅ Монітор #${id} відновлено та активовано.\n\n${buildMonitorCard(monitor)}`
          : `✅ Монітор #${id} активовано.`,
        { parse_mode: 'HTML' },
      );
      // Скинути FSM
      repo.clearDialogState(chatId);
      return;
    }

    // FSM callbacks (станції, дати, поїзди, вагони, підтвердження)
    await fsm.handleCallback(ctx);
  });

  // ─── Текстові повідомлення (FSM) ───
  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const dialogState = repo.getDialogState(chatId);

    if (!dialogState || dialogState.state === 'IDLE') {
      // Якщо не в діалозі — показати головне меню
      if (!ctx.message.text.startsWith('/')) {
        await ctx.reply('Вибери дію:', { reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    await fsm.handleText(ctx);
  });

  // ─── Глобальна обробка помилок ───
  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update }, 'Bot error');
  });

  return bot;
}

/** Отримати AlertEngine з бота (для Worker) */
export function createAlertEngine(bot: Bot, repo: Repository): AlertEngine {
  return new AlertEngine(bot, repo);
}
