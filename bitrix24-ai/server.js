const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize Google Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Bitrix24 Gemini AI Provider',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Main AI completions endpoint для Bitrix24
app.post('/ai/completions', async (req, res) => {
  try {
    console.log('Received request from Bitrix24:', JSON.stringify(req.body, null, 2));

    const {
      prompt,
      payload_role,
      context,
      temperature = 0.7,
      max_tokens = 2048
    } = req.body;

    // Проверка наличия API ключа
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY not configured',
        message: 'Please set GEMINI_API_KEY in .env file'
      });
    }

    // Формируем сообщения для Gemini
    const messages = [];
    
    // Добавляем системную роль как часть контекста
    if (payload_role) {
      messages.push(`System instruction: ${payload_role}`);
    }

    // Добавляем контекст (предыдущие сообщения)
    if (context && Array.isArray(context)) {
      context.forEach(msg => {
        if (msg.role && msg.content) {
          messages.push(`${msg.role}: ${msg.content}`);
        } else if (typeof msg === 'string') {
          messages.push(msg);
        }
      });
    }

    // Добавляем текущий запрос
    if (prompt) {
      messages.push(`User: ${prompt}`);
    }

    // Объединяем все в один промпт для Gemini
    const fullPrompt = messages.join('\n\n');

    console.log('Sending to Gemini:', fullPrompt.substring(0, 200) + '...');

    // Инициализируем модель
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: max_tokens,
      }
    });

    // Отправляем запрос к Gemini
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const text = response.text();

    console.log('Gemini response:', text.substring(0, 200) + '...');

    // Возвращаем ответ в формате, ожидаемом Bitrix24
    res.status(200).json({
      result: 'OK',
      choices: [{
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: fullPrompt.length / 4, // примерная оценка
        completion_tokens: text.length / 4,
        total_tokens: (fullPrompt.length + text.length) / 4
      }
    });

  } catch (error) {
    console.error('Error processing request:', error);
    
    // Возвращаем ошибку
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

// Test endpoint для проверки работы Gemini
app.post('/test', async (req, res) => {
  try {
    const { message = 'Hello! Can you hear me?' } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY not configured'
      });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const result = await model.generateContent(message);
    const response = await result.response;

    res.json({
      status: 'success',
      request: message,
      response: response.text()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start server
app.listen(PORT, HOST, () => {
  console.log('='.repeat(60));
  console.log('🚀 Bitrix24 Gemini AI Provider is running!');
  console.log('='.repeat(60));
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🔗 Completions endpoint: http://${HOST}:${PORT}/ai/completions`);
  console.log(`✅ Test endpoint: http://${HOST}:${PORT}/test`);
  console.log('='.repeat(60));
  console.log(`🔑 Gemini API Key: ${process.env.GEMINI_API_KEY ? '✓ Configured' : '✗ Not set'}`);
  console.log('='.repeat(60));
});
