# Cloud Run образ дашборда Leademy
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Сначала зависимости — кэш слоёв
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Код приложения
COPY dashboard ./dashboard
COPY web ./web
COPY server.js ./server.js
COPY src ./src

# Cloud Run подставит PORT (по умолчанию 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dashboard/server.js"]
