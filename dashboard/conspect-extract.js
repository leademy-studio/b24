/* conspect-extract.js — Этап 1 пайплайна: извлечение структурированного JSON
 * из сырой расшифровки встречи (см. docs/avtomatizatsiya-konspektov-plan.md §4).
 *
 * Решение: модель НЕ форматирует, а только извлекает данные по строгой схеме.
 * Основной провайдер — OpenRouter Chat Completions с response_format=json_schema.
 * Дефолтная модель: google/gemini-2.5-flash. Legacy fallback на Anthropic
 * оставлен для локальных окружений, где уже задан только ANTHROPIC_API_KEY.
 *
 * Требует OPENROUTER_API_KEY или ANTHROPIC_API_KEY (env). Без ключа —
 * внятная ошибка, не падение.
 */
import axios from "axios";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
const OPENROUTER_MODEL = normalizeOpenRouterModel(
  process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
);
const ANTHROPIC_MODEL = process.env.CONSPECT_ANTHROPIC_MODEL || "claude-opus-4-8";
const ANTHROPIC_VERSION = "2023-06-01";

export const extractConfigured = Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
export const extractProvider = process.env.OPENROUTER_API_KEY ? "openrouter" : (process.env.ANTHROPIC_API_KEY ? "anthropic" : "none");
export const extractModel = process.env.OPENROUTER_API_KEY ? OPENROUTER_MODEL : ANTHROPIC_MODEL;

function normalizeOpenRouterModel(model) {
  const m = String(model || "").trim();
  if (m === "gemini-2.5-flash") return DEFAULT_OPENROUTER_MODEL;
  return m || DEFAULT_OPENROUTER_MODEL;
}

// --- JSON-схема извлечения (план §4) ---
export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    meeting: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string" },
        type: { type: "string", enum: ["client", "internal"] },
        date: { type: "string" },
        participants: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      required: ["project", "type", "date", "participants", "summary"],
    },
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          project: { type: "string" },
          discussion: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                assignee: { type: "string" },
                direction: { type: "string", enum: ["", "web_design", "web_dev", "seo", "ppc", "content", "support", "other"] },
                text: { type: "string" },
                done: { type: "boolean" },
                clientCommitted: { type: "boolean" },
                deadlineProvisional: { type: "boolean" },
                deadline: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    raw: { type: "string" },
                    kind: { type: "string", enum: ["none", "absolute", "relative_days", "relative_weekday", "recurring"] },
                    weekday: { type: "string", enum: ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
                    which: { type: "string", enum: ["", "this", "next"] },
                    days: { type: "integer" },
                    date: { type: "string" },
                    cadence: { type: "string", enum: ["", "weekly", "monthly", "none"] },
                  },
                  required: ["raw", "kind", "weekday", "which", "days", "date", "cadence"],
                },
              },
              required: ["assignee", "direction", "text", "done", "clientCommitted", "deadlineProvisional", "deadline"],
            },
          },
        },
        required: ["title", "project", "discussion", "tasks"],
      },
    },
  },
  required: ["meeting", "themes"],
};

const SYSTEM_PROMPT = `Ты — ассистент-аналитик, который извлекает структуру из сырой расшифровки рабочего созвона (русский язык, спикеры, таймкоды, разговорная «вода»).

Твоя задача — НЕ оформлять документ, а ВЕРНУТЬ ДАННЫЕ по схеме. Форматирование сделает код.

Правила обработки текста:
- игнорируй «воду», слова-паразиты, технические заминки, приветствия, эмоции;
- вычленяй суть, факты, принятые решения и обязательства;
- группируй обсуждение по темам; внутри темы — краткая выжимка (discussion) и список задач/обязательств по участникам;
- meeting.type: "client" — встреча с клиентом; "internal" — внутренняя планёрка;
- meeting.date — дата встречи в формате YYYY-MM-DD, если её видно в тексте, иначе пустая строка.

Правила по задачам (themes[].tasks[]):
- direction — направление по сути задачи: web_design (дизайн сайта/макеты), web_dev (вёрстка/разработка/правки на сайте), seo, ppc (контекст/реклама), content (тексты/контент), support (поддержка/администрирование), other. Если не ясно — "".
- assignee — имя ответственного, если оно явно названо в разговоре; иначе "".
- done=true, если задача уже выполнена/закрыта на встрече.
- clientCommitted=true, если срок озвучен клиенту как обещание.
- deadlineProvisional=true, если срок назван с оговоркой («ориентировочно», «примерно», «постараюсь»).
- deadline: извлекай ТОЛЬКО сигнал срока, дату НЕ вычисляй:
  - kind="absolute" + date (как сказано), если названа конкретная дата;
  - kind="relative_days" + days, если «через N дней»;
  - kind="relative_weekday" + weekday (+ which: this|next), если «в пятницу / на следующей неделе во вторник»;
  - kind="recurring" + cadence, если это повторяющаяся/триггерная задача;
  - kind="none", если срок не назван;
  - raw — дословная формулировка срока из разговора (или "").

Возвращай только валидный JSON по заданной схеме.`;

/**
 * Извлечь структуру из сырого текста конспекта.
 * @param {string} rawText
 * @param {object} hint  { project?, date? } — подсказки оператора (необязательно)
 * @returns {Promise<{meeting, themes}>}
 */
export async function extractConspect(rawText, hint = {}) {
  if (!extractConfigured) {
    const err = new Error("llm_not_configured");
    err.code = "llm_not_configured";
    throw err;
  }
  if (!rawText || rawText.trim().length < 20) {
    const err = new Error("empty_raw_text");
    err.code = "empty_raw_text";
    throw err;
  }

  const userParts = [];
  if (hint.project) userParts.push(`Подсказка: проект/клиент — «${hint.project}».`);
  if (hint.date) userParts.push(`Подсказка: дата встречи — ${hint.date}.`);
  userParts.push("Расшифровка встречи:\n\n" + rawText);

  const extracted = process.env.OPENROUTER_API_KEY
    ? await extractViaOpenRouter(userParts.join("\n\n"))
    : await extractViaAnthropic(userParts.join("\n\n"));
  return normalizeExtract(extracted, hint);
}

async function extractViaOpenRouter(userContent) {
  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0,
    max_tokens: 8000,
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "extract_conspect",
        strict: true,
        schema: EXTRACT_SCHEMA,
      },
    },
  };

  const res = await axios.post(OPENROUTER_API_URL, body, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://leademy-dashboard.local",
      "X-Title": process.env.OPENROUTER_APP_NAME || "Leademy Dashboard",
    },
    timeout: 120_000,
  });

  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("extract: no OpenRouter message content");
  if (typeof content === "object") return content;
  const text = String(content).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(text);
}

async function extractViaAnthropic(userContent) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM_PROMPT + "\n\nВерни данные строго через инструмент extract_conspect.", cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: "extract_conspect",
        description: "Вернуть извлечённую структуру встречи строго по схеме.",
        input_schema: EXTRACT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "extract_conspect" },
    messages: [{ role: "user", content: userContent }],
  };

  const res = await axios.post(ANTHROPIC_API_URL, body, {
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    timeout: 120_000,
  });

  const blocks = res.data?.content || [];
  const toolUse = blocks.find((b) => b.type === "tool_use" && b.name === "extract_conspect");
  if (!toolUse?.input) throw new Error("extract: no tool_use in response");
  return toolUse.input;
}

/** Дефолты/санитизация извлечённого JSON. */
export function normalizeExtract(data = {}, hint = {}) {
  const meeting = data.meeting || {};
  const out = {
    meeting: {
      project: meeting.project || hint.project || "",
      type: meeting.type === "internal" ? "internal" : "client",
      date: meeting.date || hint.date || "",
      participants: Array.isArray(meeting.participants) ? meeting.participants : [],
      summary: meeting.summary || "",
    },
    themes: (Array.isArray(data.themes) ? data.themes : []).map((t) => ({
      title: t.title || "",
      project: t.project || "",
      discussion: t.discussion || "",
      tasks: (Array.isArray(t.tasks) ? t.tasks : []).map((x) => ({
        assignee: x.assignee || "",
        direction: x.direction || "",
        text: x.text || "",
        done: Boolean(x.done),
        clientCommitted: Boolean(x.clientCommitted),
        deadlineProvisional: Boolean(x.deadlineProvisional),
        deadline: {
          raw: x.deadline?.raw || "",
          kind: x.deadline?.kind || "none",
          weekday: x.deadline?.weekday || "",
          which: x.deadline?.which || "",
          days: Number(x.deadline?.days) || 0,
          date: x.deadline?.date || "",
          cadence: x.deadline?.cadence || "",
        },
      })),
    })),
  };
  return out;
}
