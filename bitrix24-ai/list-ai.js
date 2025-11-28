#!/usr/bin/env node

/**
 * Скрипт для получения списка зарегистрированных AI-провайдеров
 */

require('dotenv').config();

const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL;

if (!BITRIX24_WEBHOOK_URL) {
  console.error('❌ Ошибка: BITRIX24_WEBHOOK_URL не настроен в .env файле');
  process.exit(1);
}

async function listAIEngines() {
  try {
    const url = `${BITRIX24_WEBHOOK_URL}ai.engine.list`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    const data = await response.json();

    if (data.error) {
      console.error('❌ Ошибка:', data.error_description || data.error);
      process.exit(1);
    }

    console.log('\n📋 Зарегистрированные AI-провайдеры:\n');
    
    if (data.result && data.result.length > 0) {
      data.result.forEach((engine, index) => {
        console.log(`${index + 1}. ${engine.name || 'Без названия'}`);
        console.log(`   Код: ${engine.code}`);
        console.log(`   Категория: ${engine.category}`);
        console.log(`   URL: ${engine.completions_url}`);
        console.log('');
      });
    } else {
      console.log('Нет зарегистрированных провайдеров');
    }

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

listAIEngines();
