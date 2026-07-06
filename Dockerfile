# Використовуємо офіційний образ Playwright, який містить Node.js і всі системні залежності для браузерів
FROM mcr.microsoft.com/playwright:v1.44.1-focal

WORKDIR /app

# Копіюємо файли залежностей
COPY package*.json ./

# Встановлюємо залежності для збірки better-sqlite3 (make, g++, python)
RUN apt-get update && apt-get install -y build-essential python3

# Встановлюємо npm залежності
RUN npm install

# Копіюємо вихідний код
COPY . .

# Компілюємо TypeScript (переконайся, що в package.json є скрипт "build": "tsc")
RUN npm run build

# Вказуємо змінні середовища за замовчуванням
ENV NODE_ENV=production

# Запуск бота (використовуємо зібраний JS код)
CMD ["npm", "start"]
