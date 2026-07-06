// src/db/types.ts
// Типи для рядків БД

export interface DbUser {
  id: number;
  telegram_chat_id: string;
  username: string | null;
  is_whitelisted: number; // 1 or 0
  created_at: string;
}

export type MonitorStatus =
  | 'active'
  | 'paused'
  | 'found'
  | 'muted'
  | 'completed'
  | 'expired'
  | 'error';

export type AlertStage =
  | 'instant'
  | 'escalation1'
  | 'escalation2'
  | 'steady'
  | 'update'
  | 'resolved';

export interface DbMonitor {
  id: number;
  user_id: number;
  from_station_id: string;
  from_station_name: string;
  to_station_id: string;
  to_station_name: string;
  travel_date: string; // YYYY-MM-DD
  train_number: string | null;
  wagon_types: string | null; // JSON array
  seat_position: 'lower' | 'upper' | 'any';
  status: MonitorStatus;
  alert_profile: 'aggressive' | 'standard';
  found_at: string | null;
  last_alert_at: string | null;
  next_alert_at: string | null;
  alert_attempt_count: number;
  negative_checks: number;
  last_checked_at: string | null;
  last_snapshot: string | null; // JSON
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface DbNotificationLog {
  id: number;
  monitor_id: number;
  sent_at: string;
  stage: AlertStage;
  message_text: string;
  snapshot: string | null; // JSON
}

export interface DbStationCache {
  station_id: string;
  name: string;
  name_normalized: string | null;
  updated_at: string;
}

export interface DbDialogState {
  chat_id: string;
  state: string;
  data: string | null; // JSON
  updated_at: string;
}

export interface CreateMonitorParams {
  user_id: number;
  from_station_id: string;
  from_station_name: string;
  to_station_id: string;
  to_station_name: string;
  travel_date: string;
  train_number?: string | null;
  wagon_types?: string[] | null;
  seat_position?: 'lower' | 'upper' | 'any';
  alert_profile?: 'aggressive' | 'standard';
}

export interface MonitorSnapshot {
  trains: TrainSnapshot[];
  checkedAt: string;
}

export interface TrainSnapshot {
  trainNumber: string;
  trainName: string;
  departureTime: string;
  arrivalTime: string;
  wagons: WagonSnapshot[];
  totalFreeSeats: number;
}

export interface WagonSnapshot {
  number: string;
  type: string;     // тип вагона (купе, плацкарт тощо)
  typeCode: string; // внутрішній код УЗ
  freeSeats: number;
  freeSeatsLower: number;
  freeSeatsUpper: number;
  price: number; // в гривнях
  hasCond: boolean;
}
