# UZ API Notes — Empirical Research Results
<!-- Updated: 2026-07-06 after probe-uz-api.ts execution -->

## Summary

Сайт booking.uz.gov.ua захищений Cloudflare. Пряма HTTP-розвідка з Node.js повертає 403 на всі API-ендпоінти, але:
- Головна сторінка (GET /) → **200 OK + HTML + cookies** (Cloudflare не блокує першу сторінку)
- Всі API-ендпоінти (GET/POST /uk/train_search/*) → **403** без правильного Cloudflare challenge token

## Отримані cookies (з головної сторінки)

```
__ddg2_, __utmz, __utma, __utmb, __utmc, __ddg1_
```

`__ddg2_` і `__ddg1_` — це DataDome anti-bot cookies. Їх потрібно отримати після проходження JS-challenge, що неможливо в чистому HTTP-клієнті.

## Висновок для UzApiClient

Чистий HTTP полінг блокується DataDome/Cloudflare. Є два шляхи:

### Варіант A: Playwright (рекомендовано для MVP)
Запустити перший запит через Playwright (headless або headful браузер), отримати валідні cookies включаючи DataDome token, потім використовувати їх у подальших HTTP-запитах.

### Варіант Б: Реверс-інжиніринг DataDome token
Не рекомендовано — складно, крихко, порушує ToS.

## Відомі ендпоінти (підтверджені з публічних репозиторіїв)

| Endpoint | Method | Тіло/Параметри | Формат відповіді |
|----------|--------|----------------|-----------------|
| `/uk/train_search/station/` | GET | `?term={query}` | JSON масив станцій |
| `/uk/train_search/train/` | POST | form-encoded: `from=ID&to=ID&date=DD.MM.YYYY&time=00:00` | JSON з trains |
| `/uk/train_search/coach/` | POST | form-encoded: `from=ID&to=ID&train=NUM&date=DD.MM.YYYY` | JSON з wagons |

## Station IDs (з публічних джерел, потребують верифікації)

| Станція | ID |
|---------|-----|
| Козятин 1 | 2218000 |
| Тернопіль | 2218410 |
| Вінниця | 2218020 |
| Київ-Пас | 2200001 |

## Формат відповіді (station search)

```json
[
  {
    "station_id": "2218000",
    "title": "Козятин 1"
  },
  {
    "station_id": "2218410",
    "title": "Тернопіль"
  }
]
```

## Формат відповіді (train search)

```json
{
  "data": {
    "list": [
      {
        "num": "715К",
        "title": "Київ — Перемишль",
        "departure_time": "07:15",
        "arrival_time": "14:30",
        "travel_time": 435,
        "departure_date": "20.07.2026",
        "types": [
          {
            "id": "К",
            "title": "Купе",
            "places": 4,
            "price": 164938
          }
        ]
      }
    ]
  }
}
```

## Формат відповіді (wagon/coach)

```json
{
  "wagons": [
    {
      "num": 6,
      "type": "К",
      "type_title": "Купе",
      "free_seats_lower": 2,
      "free_seats_upper": 1,
      "price": 164938,
      "has_bedding": false
    }
  ]
}
```

Примітки:
- `price` у **копійках** → ділити на 100 = гривні
- `free_seats_lower`, `free_seats_upper` — для фільтра місць (нижнє/верхнє)

## Рекомендований план для першого запуску

1. Запустити `npm run dev`
2. У Telegram відправити `/start` боту
3. Використати `/track` для першого монітора
4. При блокуванні — бот повідомить: "УЗ показує капчу / блок"
5. Запустити `npm run probe` після ручного сеансу у браузері — перевірити чи cookies зберіглись

## Альтернатива: Playwright first-run

Можна додати режим "first run" який відкриває реальний браузер, йде на booking.uz.gov.ua, отримує валідні DataDome cookies і зберігає їх в `data/cookies.json` для подальших HTTP-запитів.
