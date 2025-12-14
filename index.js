const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Главная страница для проверки работоспособности
app.get('/', (req, res) => {
  res.send('Bitrix24 Task Title Automation is running');
});

// Вебхук для событий Bitrix24
app.post('/event', async (req, res) => {
  try {
    const { data } = req.body;
    const taskId = data?.TASK_ID || data?.taskId;
    if (!taskId) return res.status(400).send('No TASK_ID');

    // Получаем данные задачи
    const taskResp = await axios.post(process.env.B24_WEBHOOK_URL + '/tasks.task.get', { taskId });
    const fields = taskResp.data.result.task;
    if (fields.PARENT_ID) {
      // Получаем родительскую задачу
      const parentResp = await axios.post(process.env.B24_WEBHOOK_URL + '/tasks.task.get', { taskId: fields.PARENT_ID });
      const parentTitle = parentResp.data.result.task.title;
      // Формируем новое название
      const newTitle = `${fields.title} | ${parentTitle}`;
      // Обновляем задачу, если название отличается
      if (fields.title !== newTitle) {
        await axios.post(process.env.B24_WEBHOOK_URL + '/tasks.task.update', {
          taskId,
          fields: { TITLE: newTitle }
        });
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing event:', error?.response?.data || error.message);
    res.status(500).send('Internal error');
  }
});

// Для совместимости с Bitrix24 install URL
app.get('/install', (req, res) => {
  res.send('Install OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
