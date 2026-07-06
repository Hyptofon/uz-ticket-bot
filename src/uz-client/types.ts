// src/uz-client/types.ts
// Типи для API УЗ та внутрішніх структур клієнта

export interface UzStation {
  /** Внутрішній ID станції УЗ */
  station_id: string;
  /** Назва станції (укр.) */
  title: string;
  /** Тип об'єкта */
  type?: string;
}

export interface UzTrain {
  /** Номер поїзда, напр. "715К" */
  num: string;
  /** Назва маршруту */
  title: string;
  /** Час відправлення (рядок "HH:mm") */
  departure_time: string;
  /** Час прибуття */
  arrival_time: string;
  /** Час у дорозі (хвилини) */
  travel_time: number;
  /** Дата відправлення */
  departure_date: string;
  /** Загальна кількість вільних місць (0 = немає квитків, > 0 = є) */
  free_seats?: number;
  /** Внутрішній trip ID для запиту вагонів */
  model?: number;
  /** Список вагонів/типів з доступними місцями */
  types?: UzWagonType[];
}

export interface UzWagonType {
  /** Внутрішній код типу вагона */
  id: string;
  /** Назва типу вагона */
  title: string;
  /** Кількість вільних місць */
  places: number;
  /** Ціна в копійках (ділити на 100 = гривні) */
  price: number;
}

export interface UzWagon {
  /** Номер вагона */
  num: number;
  /** Тип вагона (внутрішній код) */
  type: string;
  /** Назва типу вагона */
  type_title?: string;
  /** Назва вагона (mockup) */
  name?: string;
  /** Вільні місця (масив або кількість) */
  places?: number[] | number;
  /** Вільних нижніх місць */
  free_seats_lower?: number;
  /** Вільних верхніх місць */
  free_seats_upper?: number;
  /** Ціна в копійках */
  price?: number;
  /** Кондиціонер */
  has_bedding?: boolean;
  /** Кількість вільних місць */
  free_seats?: number;
}

export interface UzWagonsResponse {
  wagons: UzWagon[];
  /** Загальна кількість вільних місць */
  places?: number;
}

export interface UzTrainSearchResponse {
  data?: {
    list?: UzTrain[];
  };
  trains?: UzTrain[];
  list?: UzTrain[];
}

export type UzWagonTypeCode =
  | 'К'  // купе
  | 'П'  // плацкарт
  | 'Л'  // люкс/СВ
  | 'С'  // сидячий
  | 'О'  // звичайний
  | string; // інші

/** Типи вагонів, які розуміє система */
export const WAGON_TYPE_MAP: Record<string, string[]> = {
  // Назва яку показуємо → коди УЗ
  'Купе': ['К', 'купе', 'coupe'],
  'Плацкарт': ['П', 'плацкарт', 'platzkart'],
  'Люкс/СВ': ['Л', 'люкс', 'лю', 'св', 'lux'],
  'Сидячий': ['С', 'сидячий', 'seat'],
  'Інтерсіті': ['І', 'ic', 'ic+'],
};

export const ALL_WAGON_TYPES = Object.keys(WAGON_TYPE_MAP);
