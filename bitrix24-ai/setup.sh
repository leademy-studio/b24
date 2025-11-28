#!/bin/bash

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🚀 Пошаговая настройка Bitrix24 + Google Gemini${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Шаг 1: Проверка .env файла
echo -e "\n${YELLOW}Шаг 1: Проверка конфигурации${NC}"
if [ ! -f .env ]; then
    echo "📝 Создаю .env файл..."
    cp .env.example .env
    echo -e "${GREEN}✓${NC} .env файл создан"
else
    echo -e "${GREEN}✓${NC} .env файл существует"
fi

# Проверка GEMINI_API_KEY
if ! grep -q "^GEMINI_API_KEY=.\+" .env; then
    echo -e "\n${RED}⚠️  GEMINI_API_KEY не настроен!${NC}"
    echo ""
    echo "Получите API ключ:"
    echo "1. Откройте: https://makersuite.google.com/app/apikey"
    echo "2. Войдите с Google аккаунтом"
    echo "3. Нажмите 'Create API Key'"
    echo "4. Скопируйте ключ"
    echo ""
    echo -n "Введите ваш Gemini API Key: "
    read -r GEMINI_KEY
    
    # Обновляем .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/^GEMINI_API_KEY=.*/GEMINI_API_KEY=$GEMINI_KEY/" .env
    else
        sed -i "s/^GEMINI_API_KEY=.*/GEMINI_API_KEY=$GEMINI_KEY/" .env
    fi
    echo -e "${GREEN}✓${NC} API ключ сохранен"
else
    echo -e "${GREEN}✓${NC} GEMINI_API_KEY настроен"
fi

# Проверка BITRIX24_WEBHOOK_URL
if ! grep -q "^BITRIX24_WEBHOOK_URL=.\+" .env; then
    echo -e "\n${RED}⚠️  BITRIX24_WEBHOOK_URL не настроен!${NC}"
    echo ""
    echo "Создайте вебхук в Bitrix24:"
    echo "1. Откройте ваш Bitrix24"
    echo "2. Приложения → Разработчикам → Другое → Входящий вебхук"
    echo "3. Создайте новый вебхук с правами: ai_admin"
    echo "4. Скопируйте URL (формат: https://your-domain.bitrix24.ru/rest/1/xxxxx/)"
    echo ""
    echo -n "Введите Bitrix24 Webhook URL: "
    read -r WEBHOOK_URL
    
    # Обновляем .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^BITRIX24_WEBHOOK_URL=.*|BITRIX24_WEBHOOK_URL=$WEBHOOK_URL|" .env
    else
        sed -i "s|^BITRIX24_WEBHOOK_URL=.*|BITRIX24_WEBHOOK_URL=$WEBHOOK_URL|" .env
    fi
    echo -e "${GREEN}✓${NC} Webhook URL сохранен"
else
    echo -e "${GREEN}✓${NC} BITRIX24_WEBHOOK_URL настроен"
fi

# Шаг 2: Установка зависимостей
echo -e "\n${YELLOW}Шаг 2: Проверка зависимостей${NC}"
if [ ! -d "node_modules" ]; then
    echo "📦 Установка npm пакетов..."
    npm install
    echo -e "${GREEN}✓${NC} Зависимости установлены"
else
    echo -e "${GREEN}✓${NC} Зависимости уже установлены"
fi

# Шаг 3: Тестирование Gemini API
echo -e "\n${YELLOW}Шаг 3: Тестирование Gemini API${NC}"
echo "🔄 Запуск тестового запроса к Gemini..."

# Запускаем сервер в фоне
node server.js &
SERVER_PID=$!
sleep 3

# Тестовый запрос
TEST_RESPONSE=$(curl -s -X POST http://localhost:3000/test \
  -H "Content-Type: application/json" \
  -d '{"message": "Привет!"}')

# Останавливаем сервер
kill $SERVER_PID 2>/dev/null

if echo "$TEST_RESPONSE" | grep -q '"status":"success"'; then
    echo -e "${GREEN}✓${NC} Gemini API работает!"
else
    echo -e "${RED}✗${NC} Ошибка при подключении к Gemini API"
    echo "Ответ: $TEST_RESPONSE"
fi

# Шаг 4: Настройка публичного доступа
echo -e "\n${YELLOW}Шаг 4: Настройка публичного доступа${NC}"
echo ""
echo "Для работы с Bitrix24 сервер должен быть доступен публично."
echo ""
echo "Выберите вариант:"
echo "1) Использовать ngrok (для тестирования)"
echo "2) У меня уже есть публичный сервер"
echo "3) Пропустить этот шаг"
echo ""
echo -n "Ваш выбор (1-3): "
read -r CHOICE

if [ "$CHOICE" = "1" ]; then
    echo ""
    echo "Установка ngrok..."
    if ! command -v ngrok &> /dev/null; then
        echo "📥 Устанавливаю ngrok..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            brew install ngrok
        else
            echo "Установите ngrok вручную: https://ngrok.com/download"
        fi
    else
        echo -e "${GREEN}✓${NC} ngrok уже установлен"
    fi
    
    echo ""
    echo "Запустите ngrok в новом терминале:"
    echo -e "${YELLOW}  ngrok http 3000${NC}"
    echo ""
    echo "После запуска скопируйте публичный URL (например: https://abc123.ngrok.io)"
    
elif [ "$CHOICE" = "2" ]; then
    echo ""
    echo -n "Введите ваш публичный URL (например: https://your-server.com): "
    read -r PUBLIC_URL
    echo ""
    echo "Используйте этот URL при регистрации:"
    echo -e "${YELLOW}  node register-ai.js $PUBLIC_URL${NC}"
fi

# Итоговые инструкции
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Настройка завершена!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Следующие шаги:"
echo ""
echo "1. Запустите сервер:"
echo -e "   ${YELLOW}npm start${NC}"
echo ""
echo "2. Если используете ngrok, запустите в другом терминале:"
echo -e "   ${YELLOW}ngrok http 3000${NC}"
echo ""
echo "3. Зарегистрируйте AI в Bitrix24:"
echo -e "   ${YELLOW}node register-ai.js https://your-public-url${NC}"
echo ""
echo "4. Проверьте регистрацию:"
echo -e "   ${YELLOW}node list-ai.js${NC}"
echo ""
echo "📖 Подробная документация в README.md"
echo ""
