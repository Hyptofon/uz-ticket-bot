-- src/db/schema.sql
-- Схема бази даних UZ TicketWatcher

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id  TEXT UNIQUE NOT NULL,
  username          TEXT,
  is_whitelisted    INTEGER DEFAULT 1,   -- 1 = true, 0 = false
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitors (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
  from_station_id       TEXT NOT NULL,
  from_station_name     TEXT NOT NULL,
  to_station_id         TEXT NOT NULL,
  to_station_name       TEXT NOT NULL,
  travel_date           TEXT NOT NULL,           -- формат YYYY-MM-DD
  train_number          TEXT,                    -- NULL = будь-який поїзд на напрямок
  wagon_types           TEXT,                    -- JSON-масив: ["купе","плацкарт"] або NULL = будь-який
  seat_position         TEXT DEFAULT 'any',      -- 'lower' | 'upper' | 'any'
  status                TEXT NOT NULL DEFAULT 'active',
                                                 -- active | paused | found | muted | completed | expired | error
  alert_profile         TEXT DEFAULT 'aggressive', -- 'aggressive' | 'standard'
  found_at              DATETIME,                -- момент першого виявлення поточної «хвилі» квитка
  last_alert_at         DATETIME,
  next_alert_at         DATETIME,
  alert_attempt_count   INTEGER DEFAULT 0,
  negative_checks       INTEGER DEFAULT 0,       -- лічильник для дебаунсу зникнення квитка
  last_checked_at       DATETIME,
  last_snapshot         TEXT,                    -- JSON знімок останньої перевірки
  consecutive_failures  INTEGER DEFAULT 0,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id    INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  sent_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  stage         TEXT,     -- instant | escalation1 | escalation2 | steady | update | resolved
  message_text  TEXT,
  snapshot      TEXT      -- JSON
);

CREATE TABLE IF NOT EXISTS station_cache (
  station_id       TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  name_normalized  TEXT,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dialog_state (
  chat_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,             -- FSM state name
  data        TEXT,                      -- JSON тимчасові дані діалогу
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Зберігання сесії УЗ (cookies зашифровані)
CREATE TABLE IF NOT EXISTS uz_session (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  cookies_enc TEXT,                                 -- encrypted JSON
  token_enc   TEXT,                                 -- encrypted token (якщо є)
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Індекси для швидкого доступу
CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors(status);
CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_next_alert_at ON monitors(next_alert_at);
CREATE INDEX IF NOT EXISTS idx_monitors_last_checked_at ON monitors(last_checked_at);
CREATE INDEX IF NOT EXISTS idx_notification_log_monitor_id ON notification_log(monitor_id);
