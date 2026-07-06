# Використовуємо значно легший базовий образ (node:20-slim важить ~200МБ замість 4ГБ)
FROM node:20-slim

WORKDIR /app

# Встановлюємо залежності для збірки бази даних (make, g++, python)
RUN apt-get update && apt-get install -y build-essential python3

# Копіюємо файли залежностей
COPY package*.json ./

# Встановлюємо npm залежності
RUN npm install

# Замість встановлення ВСІХ браузерів (Firefox, WebKit, Chromium), 
# ми просимо Playwright завантажити ТІЛЬКИ Chromium і його системні бібліотеки.
# Це економить близько 2.5 ГБ місця на диску!
RUN npx playwright install --with-deps chromium

# Копіюємо вихідний код
COPY . .

# Компілюємо TypeScript
RUN npm run build

# Вказуємо змінні середовища за замовчуванням
ENV NODE_ENV=production

# Запуск бота (використовуємо зібраний JS код)
CMD ["npm", "start"]
