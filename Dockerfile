# Використовуємо легкий базовий образ
FROM node:20-slim

WORKDIR /app

# Встановлюємо залежності для збірки бази даних та завантаження Chrome
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    wget \
    gnupg \
    ca-certificates \
    --no-install-recommends

# Встановлюємо Google Chrome (офіційний пакет від Google)
# Це той самий Chrome що й на локальному ПК — без CORS проблем
RUN wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb

# Копіюємо файли залежностей
COPY package*.json ./

# Встановлюємо npm залежності
RUN npm install

# Встановлюємо системні залежності Playwright (без браузерів — Chrome вже встановлено)
RUN npx playwright install-deps chromium

# Копіюємо вихідний код
COPY . .

# Компілюємо TypeScript
RUN npm run build

# Копіюємо SQL файл схеми у скомпільовану папку
RUN cp src/db/schema.sql dist/db/schema.sql

# Вказуємо змінні середовища за замовчуванням
ENV NODE_ENV=production

# Запуск бота
CMD ["npm", "start"]
