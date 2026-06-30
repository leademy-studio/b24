---
name: codex-ai-project-updates
description: Обновления проекта b24, принятые/реализованные в диалоге с Codex AI
metadata:
  node_type: memory
  type: project
  origin: codex-ai
---

Этот файл фиксирует контекст, появившийся в работе с Codex AI после базового снимка памяти. Связан с [[meeting-conspect-automation]], [[owner-dashboard-project]], [[b24-routine-task-model]].

## Конспекты встреч — статус реализации в Codex

В дашборд внедрён MVP-пайплайн вкладки **«Конспекты»**:

1. Ручной вход `.txt`: загрузка сырой расшифровки Telemost во вкладке `#conspects`.
2. Серверный ingest: `POST /api/conspect/ingest` сохраняет запись в `conspects-store` со статусом `to_parse`.
3. Разбор LLM: `POST /api/conspect/:id/extract` извлекает строгий JSON `{meeting,themes,tasks}`.
4. Черновики задач: `POST /api/conspect/:id/draft-tasks` строит задачи, резолвит дедлайны, маршрутизирует ответственных и показывает предпросмотр.
5. Подтверждение оператором: `POST /api/conspect/:id/confirm-tasks` создаёт в Bitrix только выбранные оператором задачи. Слепое автосоздание не используется.

Ключевые файлы текущей реализации:

- `dashboard/conspects-store.js` — хранение конспектов локально/GCS, статусы, дедуп-основа.
- `dashboard/conspect-extract.js` — LLM extraction в строгий JSON.
- `dashboard/conspect-deadlines.js` — резолвер дедлайнов и маршрутизация исполнителей.
- `dashboard/conspect-realism.js` — MVP-движок реалистичности сроков.
- `dashboard/conspect-api.js` — REST API пайплайна конспектов.
- `web/screens/conspects.html`, `web/conspects.js` — UI вкладки «Конспекты».

## Модель LLM

Основная модель для конспектов переключена на **OpenRouter + `google/gemini-2.5-flash`**.

Решение:

- основной provider: OpenRouter Chat Completions;
- env: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=google/gemini-2.5-flash`;
- короткое значение `gemini-2.5-flash` нормализуется в `google/gemini-2.5-flash`;
- старый `CONSPECT_MODEL=claude...` больше не должен перебивать OpenRouter-дефолт;
- Anthropic оставлен только как legacy fallback, если нет OpenRouter-ключа, но есть `ANTHROPIC_API_KEY`;
- extraction использует `response_format: json_schema` со `strict: true`.

Оценка: DeepSeek V4 Pro рассматривался как дешёвый A/B-кандидат, но не выбран дефолтом. Причина — для задачи критична стабильность JSON и качество извлечения обязательств/дедлайнов на русском. Выбран `gemini-2.5-flash` как дешёвый основной режим, с возможностью дальнейших A/B-прогонов.

## Задачи из конспектов

Подтверждение задач оператором — обязательный MVP-паттерн:

- оператор видит черновики с чекбоксами;
- можно отредактировать название, ответственного и дедлайн;
- в Bitrix создаются только выбранные строки;
- описание задачи включает источник: конспект, дата, проект/клиент, тема, контекст, срок из разговора;
- для `prospect` задачи привязываются к сделке через `UF_CRM_TASK=D_<dealId>`;
- для `project` задачи идут в выбранную рабочую группу `GROUP_ID`.

Маршрутизация:

- `web_design` → Денис Сафонов, user `31`;
- `web_dev` → Равиль Шакиров, user `1`;
- `seo` → user `101`;
- `ppc` → user `103` + соисполнитель `17`;
- явно названный человек переопределяет направление. В Codex исправлен нюанс JS regex: кириллица не работает с `\b` как ожидалось, поэтому алиасы имён сделаны без word-boundary.

## Внутренние планёрки → чаты Bitrix

Пункт §6.4 реализован как MVP:

- `subjectType=internal` больше не блокируется на этапе черновиков;
- оператор выбирает **проект по умолчанию** для `GROUP_ID` создаваемых задач;
- оператор выбирает чат направления:
  - SEO → `chat1363`;
  - PPC → `chat2045`;
- порядок для internal: сначала создаются подтверждённые задачи в Bitrix, затем формируется BBCode-конспект со ссылками на созданные задачи и отправляется через `im.message.add`;
- BBCode группируется по `theme.project`, если модель его извлекла, иначе по теме/проекту по умолчанию;
- задачи в сообщении — нумерованным списком, ссылки формата `[url=<taskUrl>]Название[/url]`.

MVP-ограничение: если внутренняя планёрка охватывает несколько проектов, `theme.project` влияет на группировку сообщения, но `GROUP_ID` задач берётся из выбранного оператором проекта по умолчанию. Расширение на будущее — селектор проекта на каждую строку черновика.

## Движок реалистичности сроков

Реализован MVP `dashboard/conspect-realism.js`.

Принцип: финальный verdict остаётся детерминированным, LLM не решает реалистичность напрямую. Нейросеть может позже обогащать входные признаки (`complexity`, `dependencies`, `riskFactors`), но расчёт должен оставаться объяснимым кодом.

Движок добавляет к каждому черновику `realism`:

- `verdict`: `green` / `yellow` / `red`;
- label: `реалистично` / `впритык` / `нереалистично`;
- причины;
- p50/p80 по закрытым задачам похожего типа и исполнителя;
- текущую нагрузку исполнителя: активные, просроченные, задачи до дедлайна;
- рабочих дней до срока;
- `suggestedInternalDeadline`;
- `suggestedClientDeadline`;
- буфер между internal/client deadline.

Если Bitrix-статистика недоступна, движок не ломает пайплайн и использует дефолтные p80-нормативы по направлениям. Оценка показывается оператору в таблице черновиков и добавляется в описание созданной задачи.

## Авто-приём писем Telemost

Для пункта «авто-приём писем Telemost» принято, что Telemost API не нужен: текст приходит email-письмом.

Что потребуется для реализации:

1. Сервисный почтовый ящик, лучше Gmail/Google Workspace под текущий GCP-стек.
2. Фильтр в почте владельца встреч: письма Telemost от «Хранитель встреч» → авто-переслать на сервисный ящик.
3. Проверить, что авто-пересылка сохраняет `.txt`-вложение.
4. Выбрать способ чтения:
   - production-рекомендация: Gmail API `watch` + Pub/Sub + Cloud Run webhook;
   - быстрый MVP: Gmail API polling или IMAP polling.
5. Реализовать MIME-парсер:
   - найти `text/plain` attachment;
   - раскодировать base64 в UTF-8;
   - извлечь `fileName`, дату и `meetingId`;
   - fallback: тело письма, если attachment отсутствует.
6. Дедуп:
   - основной ключ `meetingId`;
   - fallback hash от `fileName + rawText`.
7. После парсинга вызывать существующую логику `putConspect(...)` со `source=email`, `status=to_parse`.

Рекомендация Codex: сначала можно сделать polling-MVP, но чистый production-путь — Gmail API + Pub/Sub + Cloud Run endpoint `POST /api/conspect/email-webhook`.

## Важные проверки, которые уже выполнялись

В ходе внедрения локально проходили:

- `node --check dashboard/conspect-api.js`;
- `node --check dashboard/conspect-extract.js`;
- `node --check dashboard/conspect-deadlines.js`;
- `node --check dashboard/conspect-realism.js`;
- `node --check dashboard/conspects-store.js`;
- `node --check web/conspects.js`;
- `npm run typecheck`.

Живые вызовы OpenRouter/Bitrix для создания задач и постинга в чаты в последних шагах намеренно не запускались.
