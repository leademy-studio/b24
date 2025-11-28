#!/usr/bin/env node

/**
 * Скрипт для регистрации AI-провайдера в Bitrix24
 * Использует REST API метод ai.engine.register
 */

require('dotenv').config();

const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL;
const SERVER_URL = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;

if (!BITRIX24_WEBHOOK_URL) {
  console.error('❌ Ошибка: BITRIX24_WEBHOOK_URL не настроен в .env файле');
  console.log('\nДля получения webhook URL:');
  console.log('1. Откройте ваш Bitrix24');
  console.log('2. Перейдите в Приложения → Вебхуки');
  console.log('3. Создайте новый входящий вебхук с правами ai_admin');
  console.log('4. Скопируйте URL и добавьте в .env файл');
  process.exit(1);
}

const aiConfig = {
  name: 'Google Gemini',
  code: 'google_gemini',
  category: 'text',
  completions_url: `${SERVER_URL}/ai/completions`,
  settings: {
    code_alias: 'ChatGPT',
    model_context_type: 'token',
    model_context_limit: 32768, // Gemini поддерживает больше контекста
  }
};

async function registerAI() {
  try {
    console.log('🔄 Регистрация AI-провайдера в Bitrix24...\n');
    console.log('Конфигурация:', JSON.stringify(aiConfig, null, 2));

    const url = `${BITRIX24_WEBHOOK_URL}ai.engine.register`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(aiConfig)
    });

    const data = await response.json();

    if (data.error) {
      console.error('❌ Ошибка при регистрации:', data.error_description || data.error);
      process.exit(1);
    }

    console.log('\n✅ AI-провайдер успешно зарегистрирован!');
    console.log('ID:', data.result);
    console.log('\n📋 Настройки:');
    console.log(`  Название: ${aiConfig.name}`);
    console.log(`  Код: ${aiConfig.code}`);
    console.log(`  Endpoint: ${aiConfig.completions_url}`);
    console.log('\nТеперь вы можете использовать Google Gemini в Bitrix24 CoPilot!');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

registerAI();
