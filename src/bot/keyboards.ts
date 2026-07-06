// src/bot/keyboards.ts
// Inline-клавіатури для бота

import { InlineKeyboard } from 'grammy';
import { DbMonitor, MonitorStatus } from '../db/types';

/** Головне меню після /start */
export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Додати монітор', 'menu:track')
    .text('📋 Мої монітори', 'menu:list');
}

/** Кнопки для картки монітора в /list (залежать від статусу) */
export function monitorCardKeyboard(monitor: DbMonitor): InlineKeyboard {
  const kb = new InlineKeyboard();
  const id = monitor.id;

  switch (monitor.status as MonitorStatus) {
    case 'active':
      kb.text('⏸ Пауза', `pause:${id}`).text('🗑 Видалити', `delete:${id}`);
      break;
    case 'paused':
      kb.text('▶️ Відновити', `resume:${id}`).text('🗑 Видалити', `delete:${id}`);
      break;
    case 'found':
      kb.text('✅ Я купив(ла)', `bought:${id}`)
        .row()
        .text('🔕 Досить нагадувань', `mute:${id}`)
        .text('🗑 Видалити', `delete:${id}`);
      break;
    case 'muted':
      kb.text('✅ Я купив(ла)', `bought:${id}`).text('🗑 Видалити', `delete:${id}`);
      break;
    case 'error':
      kb.text('▶️ Спробувати знову', `resume:${id}`).text('🗑 Видалити', `delete:${id}`);
      break;
    case 'completed':
      kb.text('🗑 Видалити з історії', `delete:${id}`);
      break;
    default:
      kb.text('🗑 Видалити', `delete:${id}`);
  }

  return kb;
}

/** Кнопки вибору станцій (авто-доповнення) */
export function stationChoiceKeyboard(
  stations: Array<{ station_id: string; title: string }>,
  prefix: string, // 'from_station' | 'to_station'
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of stations.slice(0, 8)) {
    kb.text(s.title, `${prefix}:${s.station_id}`).row();
  }
  kb.text('❌ Скасувати', 'cancel');
  return kb;
}

/** Кнопки вибору поїзда */
export function trainChoiceKeyboard(
  trains: Array<{ num: string; title: string; departure_time: string; arrival_time: string; free_seats?: number }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of trains.slice(0, 12)) {
    const hasTickets = (t.free_seats ?? 0) > 0;
    const icon = hasTickets ? '🟢' : '🔴';
    const label = `${icon} ${t.num} · ${t.departure_time} → ${t.arrival_time}`;
    kb.text(label, `train:${t.num}`).row();
  }
  kb.text('🚂 Будь-який поїзд', 'train:any').row();
  kb.text('❌ Скасувати', 'cancel');
  return kb;
}

/** Мультивибір типів вагонів */
export function wagonTypeKeyboard(selectedTypes: string[] = []): InlineKeyboard {
  const ALL_TYPES = ['Купе', 'Плацкарт', 'Люкс/СВ', 'Сидячий', 'Інтерсіті'];
  const kb = new InlineKeyboard();

  for (const type of ALL_TYPES) {
    const isSelected = selectedTypes.includes(type);
    const prefix = isSelected ? '✅ ' : '';
    kb.text(`${prefix}${type}`, `wagon_type:${type}`).row();
  }

  kb.text('🚂 Будь-який тип', 'wagon_type:any').row();
  kb.text('✅ Далі', 'wagon_type:done');
  return kb;
}

/** Підтвердження збереження монітора */
export function confirmMonitorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Зберегти', 'confirm:save')
    .text('❌ Скасувати', 'cancel');
}

/** Кнопки для inline-календаря (наступні 30 днів) */
export function datePickerKeyboard(year: number, month: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const now = new Date();
  const daysInMonth = new Date(year, month, 0).getDate();

  let dayCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue;
    if (dayCount > 0 && dayCount % 7 === 0) kb.row();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    kb.text(String(d), `date:${dateStr}`);
    dayCount++;
  }

  // Навігація між місяцями
  const prevMonth = month === 1 ? 12 : month - 1;
  const nextMonth = month === 12 ? 1 : month + 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextYear = month === 12 ? year + 1 : year;
  kb.row()
    .text('◀️', `cal_nav:${prevYear}:${prevMonth}`)
    .text(
      `${String(month).padStart(2, '0')}.${year}`,
      'cal_nav:noop',
    )
    .text('▶️', `cal_nav:${nextYear}:${nextMonth}`)
    .row()
    .text('❌ Скасувати', 'cancel');

  return kb;
}
