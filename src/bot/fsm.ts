import { Context, Bot } from 'grammy';
import { Repository } from '../db/repository';
import { UzApiClient, CaptchaDetectedError } from '../uz-client/uz-api-client';
import { UzSessionManager } from '../uz-client/uz-session-manager';
import { config } from '../config';
import { logger } from '../logger';
import {
  stationChoiceKeyboard,
  trainChoiceKeyboard,
  wagonTypeKeyboard,
  confirmMonitorKeyboard,
  datePickerKeyboard,
} from './keyboards';
import { buildMonitorCard } from './message-templates';
import { UzTrain } from '../uz-client/types';

export type FsmState =
  | 'IDLE'
  | 'AWAITING_FROM'
  | 'AWAITING_FROM_CONFIRM'
  | 'AWAITING_TO'
  | 'AWAITING_TO_CONFIRM'
  | 'AWAITING_DATE'
  | 'AWAITING_TRAIN'
  | 'AWAITING_FILTERS'
  | 'CONFIRM';

interface FsmData {
  from_station_id?: string;
  from_station_name?: string;
  to_station_id?: string;
  to_station_name?: string;
  travel_date?: string;
  train_number?: string | null;
  wagon_types?: string[];
  available_trains?: UzTrain[];
  last_search_stations?: Array<{ id: string; name: string }>;
}

export class MonitorFsm {
  private sessionManager: UzSessionManager;

  constructor(
    private repo: Repository,
    private uzClient: UzApiClient,
  ) {
    this.sessionManager = new UzSessionManager();
  }

  private getData(chatId: string): FsmData {
    return this.repo.getDialogData<FsmData>(chatId) ?? {};
  }

  private setState(chatId: string, state: FsmState, data?: FsmData): void {
    this.repo.setDialogState(chatId, state, data as object | undefined);
  }

  private getState(chatId: string): FsmState {
    const ds = this.repo.getDialogState(chatId);
    return (ds?.state as FsmState) ?? 'IDLE';
  }

  /**
   * Обгортка для запитів до УЗ з автоматичним відновленням сесії.
   */
  private async executeWithRetry<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err: any) {
      const isCaptcha = err instanceof CaptchaDetectedError || err?.response?.status === 403;
      if (isCaptcha) {
        logger.warn('FSM: UZ API blocked. Attempting session recovery...');
        await ctx.reply('⚠️ Зв\'язок з УЗ заблоковано. Запускаю автоматичне відновлення сесії, зачекайте...');
        
        // Спроба відновити в headless режимі
        let success = await this.sessionManager.refreshSession(
          this.uzClient.getCookieJar(),
          config.uz.baseUrl,
          true,
          this.uzClient.getUserAgent()
        );

        // Якщо headless не допоміг — запускаємо headful
        if (!success) {
          await ctx.reply('🔧 Безголовне відновлення не вдалося. Запускаю вікно браузера для ручного вирішення (60 сек)...');
          success = await this.sessionManager.refreshSession(
            this.uzClient.getCookieJar(),
            config.uz.baseUrl,
            false,
            this.uzClient.getUserAgent()
          );
        }

        if (success) {
          this.uzClient.setSessionInitialized(true);
          await ctx.reply('✅ Сесію успішно відновлено! Повторюю запит...');
          return await action(); // Повторюємо запит з новими кукі
        } else {
          await ctx.reply('❌ Не вдалося відновити сесію. Спробуйте пізніше або напишіть /track знову.');
          throw new Error('Session recovery failed');
        }
      }
      throw err;
    }
  }

  async startTrack(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    this.setState(chatId, 'AWAITING_FROM', {});
    await ctx.reply(
      '🗺 <b>Крок 1/5: Станція відправлення</b>\n\nВведи назву станції (українською або англійською):',
      { parse_mode: 'HTML' },
    );
  }

  async handleText(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const text = ctx.message?.text?.trim() ?? '';
    const state = this.getState(chatId);

    switch (state) {
      case 'AWAITING_FROM':
        await this.handleFromSearch(ctx, chatId, text);
        break;
      case 'AWAITING_TO':
        await this.handleToSearch(ctx, chatId, text);
        break;
      case 'AWAITING_DATE':
        await this.handleDateInput(ctx, chatId, text);
        break;
      default:
        // Не в діалозі — ігноруємо або підказуємо
        break;
    }
  }

  async handleCallback(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const data = ctx.callbackQuery?.data ?? '';
    const state = this.getState(chatId);

    await ctx.answerCallbackQuery();

    if (data === 'cancel') {
      await this.cancelDialog(ctx, chatId);
      return;
    }

    if (data.startsWith('from_station:')) {
      await this.handleFromConfirm(ctx, chatId, data);
    } else if (data.startsWith('to_station:')) {
      await this.handleToConfirm(ctx, chatId, data);
    } else if (data.startsWith('date:')) {
      await this.handleDateConfirm(ctx, chatId, data.replace('date:', ''));
    } else if (data.startsWith('cal_nav:')) {
      await this.handleCalNav(ctx, data);
    } else if (data.startsWith('train:')) {
      await this.handleTrainConfirm(ctx, chatId, data);
    } else if (data.startsWith('wagon_type:')) {
      await this.handleWagonType(ctx, chatId, data);
    } else if (data === 'confirm:save') {
      await this.handleConfirmSave(ctx, chatId);
    }
  }

  private async handleFromSearch(ctx: Context, chatId: string, term: string): Promise<void> {
    try {
      const stations = await this.executeWithRetry(ctx, () => this.uzClient.searchStations(term));
      if (stations.length === 0) {
        await ctx.reply('❌ Станцію не знайдено. Спробуй інше написання.');
        return;
      }
      const fsmData = this.getData(chatId);
      fsmData.last_search_stations = stations.map((s: any) => ({ id: s.station_id, name: s.title }));
      this.setState(chatId, 'AWAITING_FROM_CONFIRM', fsmData);
      await ctx.reply('Обери станцію відправлення:', {
        reply_markup: stationChoiceKeyboard(stations, 'from_station'),
      });
    } catch (err) {
      logger.error({ err }, 'FSM: handleFromSearch error');
    }
  }

  private async handleToSearch(ctx: Context, chatId: string, term: string): Promise<void> {
    try {
      const stations = await this.executeWithRetry(ctx, () => this.uzClient.searchStations(term));
      if (stations.length === 0) {
        await ctx.reply('❌ Станцію не знайдено. Спробуй інше написання.');
        return;
      }
      const fsmData = this.getData(chatId);
      fsmData.last_search_stations = stations.map((s: any) => ({ id: s.station_id, name: s.title }));
      this.setState(chatId, 'AWAITING_TO_CONFIRM', fsmData);
      await ctx.reply('Обери станцію прибуття:', {
        reply_markup: stationChoiceKeyboard(stations, 'to_station'),
      });
    } catch (err) {
      logger.error({ err }, 'FSM: handleToSearch error');
    }
  }

  private async handleFromConfirm(ctx: Context, chatId: string, data: string): Promise<void> {
    // Format: from_station:{id}
    const parts = data.split(':');
    const stationId = parts[1];

    const fsmData = this.getData(chatId);
    const station = fsmData.last_search_stations?.find(s => s.id === stationId);
    const stationName = station?.name ?? 'Невідома станція';

    fsmData.from_station_id = stationId;
    fsmData.from_station_name = stationName;

    this.repo.upsertStation(stationId, stationName);
    this.setState(chatId, 'AWAITING_TO', fsmData);

    await ctx.reply(
      `✅ Відправлення: <b>${stationName}</b>\n\n🗺 <b>Крок 2/5: Станція прибуття</b>\n\nВведи назву станції:`,
      { parse_mode: 'HTML' },
    );
  }

  private async handleToConfirm(ctx: Context, chatId: string, data: string): Promise<void> {
    const parts = data.split(':');
    const stationId = parts[1];

    const fsmData = this.getData(chatId);
    const station = fsmData.last_search_stations?.find(s => s.id === stationId);
    const stationName = station?.name ?? 'Невідома станція';

    fsmData.to_station_id = stationId;
    fsmData.to_station_name = stationName;

    this.repo.upsertStation(stationId, stationName);
    this.setState(chatId, 'AWAITING_DATE', fsmData);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    await ctx.reply(
      `✅ Прибуття: <b>${stationName}</b>\n\n📅 <b>Крок 3/5: Дата поїздки</b>\n\nОбери дату або введи у форматі ДД.ММ.РРРР:`,
      {
        parse_mode: 'HTML',
        reply_markup: datePickerKeyboard(year, month),
      },
    );
  }

  private async handleDateInput(ctx: Context, chatId: string, text: string): Promise<void> {
    // Підтримка форматів: DD.MM.YYYY або YYYY-MM-DD
    let dateStr: string | null = null;

    const dmyMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dmyMatch) {
      const [, d, m, y] = dmyMatch;
      dateStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      dateStr = text;
    }

    if (!dateStr) {
      await ctx.reply('❌ Невірний формат дати. Введи ДД.ММ.РРРР (наприклад: 20.07.2026)');
      return;
    }

    await this.handleDateConfirm(ctx, chatId, dateStr);
  }

  private async handleDateConfirm(ctx: Context, chatId: string, dateStr: string): Promise<void> {
    const date = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (date < today) {
      await ctx.reply('⚠️ Дата в минулому. Будь ласка, обери майбутню дату.');
      return;
    }

    const fsmData = this.getData(chatId);
    fsmData.travel_date = dateStr;

    // Перевірка вікна продажу (зазвичай 60 днів наперед)
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 90);
    if (date > maxDate) {
      await ctx.reply(
        '⚠️ Ця дата може бути поза межами відкритого продажу квитків. ' +
        'Монітор буде збережено, але квитки можуть з\'явитися пізніше.',
      );
    }

    this.setState(chatId, 'AWAITING_TRAIN', fsmData);

    // Отримати поїзди на цей маршрут/дату
    const { from_station_id, to_station_id } = fsmData;
    const [year, month, day] = dateStr.split('-');
    const displayDate = `${day}.${month}.${year}`;

    await ctx.reply(
      `✅ Дата: <b>${displayDate}</b>\n\n🚂 <b>Крок 4/5: Вибір поїзда</b>\n\nЗавантажую розклад...`,
      { parse_mode: 'HTML' },
    );

    try {
      const trains = await this.uzClient.searchTrains(
        from_station_id!,
        to_station_id!,
        dateStr,
        fsmData.from_station_name,
        fsmData.to_station_name
      );
      fsmData.available_trains = trains;
      this.setState(chatId, 'AWAITING_TRAIN', fsmData);

      if (trains.length === 0) {
        await ctx.reply(
          '⚠️ Поїздів на цей маршрут/дату не знайдено.\n' +
          'Можливо, продаж ще не відкрито або маршрут не існує.\n\n' +
          'Обери дію:',
          { reply_markup: trainChoiceKeyboard([]) },
        );
      } else {
        const withTickets = trains.filter(t => (t.free_seats ?? 0) > 0).length;
        const noTickets = trains.length - withTickets;
        const hint = noTickets > 0
          ? `\n🟢 є квитки  🔴 немає квитків (можна відстежувати!)`
          : `\n🟢 на всі поїзди є квитки`;
        await ctx.reply(
          `🚂 Знайдено поїздів: <b>${trains.length}</b>${hint}\n\nОбери конкретний поїзд для відстеження або "Будь-який":`,
          { parse_mode: 'HTML', reply_markup: trainChoiceKeyboard(trains) },
        );
      }
    } catch {
      fsmData.available_trains = [];
      this.setState(chatId, 'AWAITING_TRAIN', fsmData);
      await ctx.reply(
        '⚠️ Не вдалося завантажити розклад (УЗ API недоступне).\nОбери "Будь-який поїзд" або спробуй пізніше.',
        { reply_markup: trainChoiceKeyboard([]) },
      );
    }
  }

  private async handleCalNav(ctx: Context, data: string): Promise<void> {
    if (data === 'cal_nav:noop') return;
    const parts = data.split(':');
    const year = parseInt(parts[1]);
    const month = parseInt(parts[2]);
    await ctx.editMessageReplyMarkup({ reply_markup: datePickerKeyboard(year, month) });
  }

  private async handleTrainConfirm(ctx: Context, chatId: string, data: string): Promise<void> {
    const trainNum = data.replace('train:', '');
    const fsmData = this.getData(chatId);

    fsmData.train_number = trainNum === 'any' ? null : trainNum;
    this.setState(chatId, 'AWAITING_FILTERS', fsmData);

    const trainStr = trainNum === 'any' ? 'Будь-який поїзд' : `Поїзд №${trainNum}`;

    await ctx.reply(
      `✅ ${trainStr}\n\n💺 <b>Крок 5/5: Тип вагона</b>\n\nОбери типи вагонів (або пропусти — будь-який):`,
      {
        parse_mode: 'HTML',
        reply_markup: wagonTypeKeyboard([]),
      },
    );
  }

  private async handleWagonType(ctx: Context, chatId: string, data: string): Promise<void> {
    const typeStr = data.replace('wagon_type:', '');
    const fsmData = this.getData(chatId);

    if (typeStr === 'done' || typeStr === 'any') {
      if (typeStr === 'any') {
        fsmData.wagon_types = undefined;
      }
      this.setState(chatId, 'CONFIRM', fsmData);
      await this.showConfirmation(ctx, chatId, fsmData);
      return;
    }

    // Мультивибір: toggle
    if (!fsmData.wagon_types) fsmData.wagon_types = [];
    const idx = fsmData.wagon_types.indexOf(typeStr);
    if (idx >= 0) {
      fsmData.wagon_types.splice(idx, 1);
    } else {
      fsmData.wagon_types.push(typeStr);
    }

    this.setState(chatId, 'AWAITING_FILTERS', fsmData);

    await ctx.editMessageReplyMarkup({
      reply_markup: wagonTypeKeyboard(fsmData.wagon_types),
    });
  }

  private async showConfirmation(ctx: Context, chatId: string, fsmData: FsmData): Promise<void> {
    const [year, month, day] = (fsmData.travel_date ?? '').split('-');
    const displayDate = `${day}.${month}.${year}`;
    const trainStr = fsmData.train_number ? ` №${fsmData.train_number}` : ' (будь-який)';
    const wagonsStr =
      fsmData.wagon_types && fsmData.wagon_types.length > 0
        ? fsmData.wagon_types.join(', ')
        : 'будь-який';

    const summary =
      `📋 <b>Підтвердження монітора:</b>\n\n` +
      `🗺 ${fsmData.from_station_name} → ${fsmData.to_station_name}\n` +
      `📅 ${displayDate}\n` +
      `🚂 Поїзд${trainStr}\n` +
      `💺 Вагон: ${wagonsStr}\n\n` +
      `Зберегти?`;

    await ctx.reply(summary, {
      parse_mode: 'HTML',
      reply_markup: confirmMonitorKeyboard(),
    });
  }

  private async handleConfirmSave(ctx: Context, chatId: string): Promise<void> {
    const fsmData = this.getData(chatId);
    const user = this.repo.getUserByChatId(chatId);
    if (!user) {
      await ctx.reply('❌ Помилка: користувача не знайдено.');
      return;
    }

    // Перевірка дублікату
    const duplicate = this.repo.findDuplicateMonitor(
      user.id,
      fsmData.from_station_id!,
      fsmData.to_station_id!,
      fsmData.travel_date!,
      fsmData.train_number ?? null,
    );

    if (duplicate) {
      await ctx.reply(
        `⚠️ Такий монітор вже існує (ID #${duplicate.id}, статус: ${duplicate.status}).\n` +
        `Хочеш оновити існуючий чи створити ще один?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Оновити існуючий', callback_data: `update_monitor:${duplicate.id}` },
                { text: '➕ Створити ще один', callback_data: 'confirm:force_save' },
              ],
              [{ text: '❌ Скасувати', callback_data: 'cancel' }],
            ],
          },
        },
      );
      return;
    }

    await this.saveMonitor(ctx, chatId, fsmData, user.id);
  }

  async handleForceSave(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const fsmData = this.getData(chatId);
    const user = this.repo.getUserByChatId(chatId);
    if (!user) return;
    await this.saveMonitor(ctx, chatId, fsmData, user.id);
  }

  private async saveMonitor(
    ctx: Context,
    chatId: string,
    fsmData: FsmData,
    userId: number,
  ): Promise<void> {
    const monitor = this.repo.createMonitor({
      user_id: userId,
      from_station_id: fsmData.from_station_id!,
      from_station_name: fsmData.from_station_name!,
      to_station_id: fsmData.to_station_id!,
      to_station_name: fsmData.to_station_name!,
      travel_date: fsmData.travel_date!,
      train_number: fsmData.train_number ?? null,
      wagon_types:
        fsmData.wagon_types && fsmData.wagon_types.length > 0
          ? fsmData.wagon_types
          : null,
      seat_position: 'any',
    });

    this.repo.clearDialogState(chatId);

    logger.info({ monitorId: monitor.id, chatId }, 'Monitor created');

    await ctx.reply(
      `✅ <b>Монітор #${monitor.id} збережено!</b>\n\n` +
      buildMonitorCard(monitor) +
      '\n\nПочинаю відстеження 🚀',
      { parse_mode: 'HTML' },
    );
  }

  private async cancelDialog(ctx: Context, chatId: string): Promise<void> {
    this.repo.clearDialogState(chatId);
    await ctx.reply('❌ Скасовано. Напиши /track щоб почати заново або /list для перегляду моніторів.');
  }
}
