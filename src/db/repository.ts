// src/db/repository.ts
// Repository — єдина точка доступу до SQLite.
// Ніхто інший не робить SQL напряму.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
  DbUser,
  DbMonitor,
  DbNotificationLog,
  DbStationCache,
  DbDialogState,
  CreateMonitorParams,
  MonitorStatus,
  AlertStage,
  MonitorSnapshot,
} from './types';

export class Repository {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? config.database.path;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.initSchema();
    logger.info({ dbPath: resolvedPath }, 'Database initialized');
  }

  private initSchema(): void {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  // ==================== USERS ====================

  upsertUser(chatId: string, username?: string): DbUser {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_chat_id, username)
      VALUES (?, ?)
      ON CONFLICT(telegram_chat_id) DO UPDATE SET
        username = excluded.username
      RETURNING *
    `);
    return stmt.get(chatId, username ?? null) as DbUser;
  }

  getUserByChatId(chatId: string): DbUser | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE telegram_chat_id = ?')
      .get(chatId) as DbUser | undefined;
  }

  isUserWhitelisted(chatId: string): boolean {
    const user = this.getUserByChatId(chatId);
    return user?.is_whitelisted === 1;
  }

  setUserWhitelisted(chatId: string, whitelisted: boolean): void {
    this.db
      .prepare('UPDATE users SET is_whitelisted = ? WHERE telegram_chat_id = ?')
      .run(whitelisted ? 1 : 0, chatId);
  }

  markUserInactive(chatId: string): void {
    this.db
      .prepare('UPDATE users SET is_whitelisted = 0 WHERE telegram_chat_id = ?')
      .run(chatId);
  }

  // ==================== MONITORS ====================

  createMonitor(params: CreateMonitorParams): DbMonitor {
    const stmt = this.db.prepare(`
      INSERT INTO monitors (
        user_id, from_station_id, from_station_name,
        to_station_id, to_station_name, travel_date,
        train_number, wagon_types, seat_position, alert_profile
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return stmt.get(
      params.user_id,
      params.from_station_id,
      params.from_station_name,
      params.to_station_id,
      params.to_station_name,
      params.travel_date,
      params.train_number ?? null,
      params.wagon_types ? JSON.stringify(params.wagon_types) : null,
      params.seat_position ?? 'any',
      params.alert_profile ?? 'aggressive',
    ) as DbMonitor;
  }

  getMonitorById(id: number): DbMonitor | undefined {
    return this.db
      .prepare('SELECT * FROM monitors WHERE id = ?')
      .get(id) as DbMonitor | undefined;
  }

  getMonitorsByUserId(userId: number): DbMonitor[] {
    return this.db
      .prepare('SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as DbMonitor[];
  }

  getMonitorsByUserChatId(chatId: string): DbMonitor[] {
    return this.db
      .prepare(`
        SELECT m.* FROM monitors m
        JOIN users u ON u.id = m.user_id
        WHERE u.telegram_chat_id = ?
        ORDER BY m.created_at DESC
      `)
      .all(chatId) as DbMonitor[];
  }

  /** Монітори для Worker: active, found, muted */
  getWorkableMonitors(): DbMonitor[] {
    return this.db
      .prepare("SELECT * FROM monitors WHERE status IN ('active', 'found', 'muted')")
      .all() as DbMonitor[];
  }

  /** Знайти дублікат монітора */
  findDuplicateMonitor(
    userId: number,
    fromId: string,
    toId: string,
    date: string,
    trainNumber: string | null,
  ): DbMonitor | undefined {
    return this.db
      .prepare(`
        SELECT * FROM monitors
        WHERE user_id = ? AND from_station_id = ? AND to_station_id = ?
          AND travel_date = ? AND COALESCE(train_number, '') = COALESCE(?, '')
          AND status NOT IN ('completed', 'expired')
      `)
      .get(userId, fromId, toId, date, trainNumber ?? '') as DbMonitor | undefined;
  }

  updateMonitorStatus(id: number, status: MonitorStatus): void {
    this.db
      .prepare("UPDATE monitors SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, id);
  }

  /** Оновлення при знаходженні квитка (перша поява хвилі) */
  markMonitorFound(id: number, snapshot: MonitorSnapshot): void {
    this.db
      .prepare(`
        UPDATE monitors SET
          status = 'found',
          found_at = CURRENT_TIMESTAMP,
          alert_attempt_count = 0,
          negative_checks = 0,
          last_snapshot = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(JSON.stringify(snapshot), id);
  }

  /** Оновлення next_alert_at та attempt_count після відправки сповіщення */
  updateAfterAlert(id: number, nextAlertAt: Date, stage: AlertStage): void {
    this.db
      .prepare(`
        UPDATE monitors SET
          last_alert_at = CURRENT_TIMESTAMP,
          next_alert_at = ?,
          alert_attempt_count = alert_attempt_count + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(nextAlertAt.toISOString(), id);
  }

  /** Оновлення snapshot (при зміні кількості місць) */
  updateSnapshot(id: number, snapshot: MonitorSnapshot): void {
    this.db
      .prepare(`
        UPDATE monitors SET
          last_snapshot = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(JSON.stringify(snapshot), id);
  }

  /** Після перевірки — оновити last_checked_at та обнулити/збільшити consecutive_failures */
  updateAfterCheck(id: number, success: boolean): void {
    if (success) {
      this.db
        .prepare(`
          UPDATE monitors SET
            last_checked_at = CURRENT_TIMESTAMP,
            consecutive_failures = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(id);
    } else {
      this.db
        .prepare(`
          UPDATE monitors SET
            last_checked_at = CURRENT_TIMESTAMP,
            consecutive_failures = consecutive_failures + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(id);
    }
  }

  /** Збільшити лічильник негативних перевірок (дебаунс зникнення квитка) */
  incrementNegativeChecks(id: number): number {
    const result = this.db
      .prepare(`
        UPDATE monitors SET
          negative_checks = negative_checks + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        RETURNING negative_checks
      `)
      .get(id) as { negative_checks: number };
    return result.negative_checks;
  }

  /** Скинути negative_checks (при появі квитка знову) */
  resetNegativeChecks(id: number): void {
    this.db
      .prepare('UPDATE monitors SET negative_checks = 0 WHERE id = ?')
      .run(id);
  }

  /** Перехід з found назад в active (квиток зник після дебаунсу) */
  markMonitorResolved(id: number): void {
    this.db
      .prepare(`
        UPDATE monitors SET
          status = 'active',
          found_at = NULL,
          next_alert_at = NULL,
          alert_attempt_count = 0,
          negative_checks = 0,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(id);
  }

  deleteMonitor(id: number): void {
    this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  }

  // ==================== NOTIFICATION LOG ====================

  logNotification(
    monitorId: number,
    stage: AlertStage,
    messageText: string,
    snapshot?: MonitorSnapshot,
  ): void {
    this.db
      .prepare(`
        INSERT INTO notification_log (monitor_id, stage, message_text, snapshot)
        VALUES (?, ?, ?, ?)
      `)
      .run(monitorId, stage, messageText, snapshot ? JSON.stringify(snapshot) : null);
  }

  getNotificationCount(monitorId: number): number {
    const result = this.db
      .prepare('SELECT COUNT(*) as cnt FROM notification_log WHERE monitor_id = ?')
      .get(monitorId) as { cnt: number };
    return result.cnt;
  }

  // ==================== STATION CACHE ====================

  getStation(stationId: string): DbStationCache | undefined {
    return this.db
      .prepare('SELECT * FROM station_cache WHERE station_id = ?')
      .get(stationId) as DbStationCache | undefined;
  }

  searchStationsCache(term: string): DbStationCache[] {
    const normalized = term.toLowerCase();
    return this.db
      .prepare(`
        SELECT * FROM station_cache
        WHERE name_normalized LIKE ?
        LIMIT 10
      `)
      .all(`%${normalized}%`) as DbStationCache[];
  }

  upsertStation(stationId: string, name: string): void {
    const normalized = name.toLowerCase().replace(/[ʼ']/g, "'");
    this.db
      .prepare(`
        INSERT INTO station_cache (station_id, name, name_normalized)
        VALUES (?, ?, ?)
        ON CONFLICT(station_id) DO UPDATE SET
          name = excluded.name,
          name_normalized = excluded.name_normalized,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(stationId, name, normalized);
  }

  // ==================== DIALOG STATE (FSM) ====================

  getDialogState(chatId: string): DbDialogState | undefined {
    return this.db
      .prepare('SELECT * FROM dialog_state WHERE chat_id = ?')
      .get(chatId) as DbDialogState | undefined;
  }

  setDialogState(chatId: string, state: string, data?: object): void {
    this.db
      .prepare(`
        INSERT INTO dialog_state (chat_id, state, data, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chat_id) DO UPDATE SET
          state = excluded.state,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(chatId, state, data ? JSON.stringify(data) : null);
  }

  clearDialogState(chatId: string): void {
    this.db.prepare('DELETE FROM dialog_state WHERE chat_id = ?').run(chatId);
  }

  getDialogData<T = Record<string, unknown>>(chatId: string): T | null {
    const state = this.getDialogState(chatId);
    if (!state?.data) return null;
    try {
      return JSON.parse(state.data) as T;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let _repo: Repository | null = null;

export function getRepository(): Repository {
  if (!_repo) {
    _repo = new Repository();
  }
  return _repo;
}
