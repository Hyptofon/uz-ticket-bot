FROM node:20-alpine

# Встановити залежності для Playwright (chromium) та better-sqlite3
RUN apk add --no-cache \
  python3 \
  make \
  g++ \
  chromium \
  nss \
  freetype \
  freetype-dev \
  harfbuzz \
  ca-certificates \
  ttf-freefont

# Дозволити Playwright знайти Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Спочатку копіюємо package.json для кешування шару залежностей
COPY package*.json ./

# Встановити залежності (production + dev для build)
RUN npm ci

# Копіюємо вихідний код
COPY tsconfig.json ./
COPY src/ ./src/

# Компілюємо TypeScript
RUN npm run build

# Прибираємо dev залежності
RUN npm ci --only=production

# Дані (SQLite DB) монтуються як volume
VOLUME ["/app/data"]

# Логи
VOLUME ["/app/logs"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
