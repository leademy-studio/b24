/* conspects-store.js — персистентное хранилище конспектов встреч.
 *
 * Источник правды для пайплайна «встреча → конспект → задачи» (см.
 * docs/avtomatizatsiya-konspektov-plan.md). Хранит сырой .txt, извлечённый
 * JSON, черновики и созданные задачи; обеспечивает идемпотентность по хешу.
 *
 * Бэкенд:
 *   - GCS (keyless ADC), если задан env CONSPECTS_BUCKET — оргполитика
 *     запрещает SA-ключи, поэтому используем привязанный к ревизии SA;
 *   - локальная ФС (CONSPECTS_DIR или ./.data/conspects) — для dev/тестов,
 *     если бакет не задан.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const BUCKET = process.env.CONSPECTS_BUCKET || "";
const PREFIX = process.env.CONSPECTS_PREFIX || "conspects";
const LOCAL_DIR = process.env.CONSPECTS_DIR || path.resolve(process.cwd(), ".data", "conspects");

export const STATUSES = ["to_parse", "extracted", "tasks_drafted", "done", "unassigned"];
export const SUBJECT_TYPES = ["", "project", "prospect", "internal", "unassigned"];

// --- Ленивая инициализация GCS (только если задан бакет) ---
let _bucket = null;
async function gcsBucket() {
  if (!BUCKET) return null;
  if (_bucket) return _bucket;
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined });
  _bucket = storage.bucket(BUCKET);
  return _bucket;
}

function keyFor(id) {
  return `${PREFIX}/${id}.json`;
}

// --- Парсинг даты/типа из имени файла Telemost ---
// «2026-06-10 11_11 (MSK) 6373415481.txt» → { date: "2026-06-10", meetingId }
export function parseMeetingFromFilename(fileName = "") {
  const m = String(fileName).match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{1,2})[_:](\d{2}).*?(\d{6,})?/);
  if (!m) return { date: null, meetingId: null };
  return { date: `${m[1]}-${m[2]}-${m[3]}`, meetingId: m[6] || null };
}

export function newId() {
  return Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

/** Хеш задачи для идемпотентности: проект + дата встречи + текст. */
export function taskHash({ subjectId, date, text }) {
  return crypto
    .createHash("sha1")
    .update([subjectId || "", date || "", String(text || "").trim().toLowerCase()].join("|"))
    .digest("hex")
    .slice(0, 16);
}

function nowISO() {
  return new Date().toISOString();
}

/** Нормализация/дефолты записи конспекта. */
export function normalizeRecord(rec = {}) {
  const r = { ...rec };
  r.id = r.id || newId();
  r.createdAt = r.createdAt || nowISO();
  r.updatedAt = nowISO();
  r.status = STATUSES.includes(r.status) ? r.status : "to_parse";
  r.source = r.source || "upload";
  r.fileName = r.fileName || "";
  r.date = r.date || null;
  r.participants = Array.isArray(r.participants) ? r.participants : [];
  r.subjectType = SUBJECT_TYPES.includes(r.subjectType) ? r.subjectType : "";
  r.subjectId = r.subjectId ?? null;
  r.subjectName = r.subjectName || "";
  r.internalDirection = r.internalDirection || "";
  r.internalChatId = r.internalChatId || "";
  r.rawText = r.rawText || "";
  r.extracted = r.extracted || null;
  r.draftTasks = Array.isArray(r.draftTasks) ? r.draftTasks : null;
  r.createdTasks = Array.isArray(r.createdTasks) ? r.createdTasks : [];
  return r;
}

// === Бэкенд: GCS ===
async function gcsPut(rec) {
  const bucket = await gcsBucket();
  const file = bucket.file(keyFor(rec.id));
  await file.save(JSON.stringify(rec), { contentType: "application/json", resumable: false });
  return rec;
}
async function gcsGet(id) {
  const bucket = await gcsBucket();
  const file = bucket.file(keyFor(id));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString("utf8"));
}
async function gcsList() {
  const bucket = await gcsBucket();
  const [files] = await bucket.getFiles({ prefix: `${PREFIX}/` });
  const out = [];
  for (const f of files) {
    if (!f.name.endsWith(".json")) continue;
    const [buf] = await f.download();
    out.push(JSON.parse(buf.toString("utf8")));
  }
  return out;
}

// === Бэкенд: локальная ФС ===
async function fsEnsure() {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
}
async function fsPut(rec) {
  await fsEnsure();
  await fs.writeFile(path.join(LOCAL_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2), "utf8");
  return rec;
}
async function fsGet(id) {
  try {
    const buf = await fs.readFile(path.join(LOCAL_DIR, `${id}.json`), "utf8");
    return JSON.parse(buf);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function fsList() {
  await fsEnsure();
  const names = (await fs.readdir(LOCAL_DIR)).filter((n) => n.endsWith(".json"));
  const out = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(LOCAL_DIR, n), "utf8")));
    } catch { /* skip corrupt */ }
  }
  return out;
}

// === Публичный API хранилища ===
export const conspectsBackend = BUCKET ? "gcs" : "fs";

export async function putConspect(record) {
  const rec = normalizeRecord(record);
  return BUCKET ? gcsPut(rec) : fsPut(rec);
}

export async function getConspect(id) {
  if (!id) return null;
  return BUCKET ? gcsGet(id) : fsGet(id);
}

/** Список (новые первыми). Без тяжёлого rawText в карточках — отдаём через summary(). */
export async function listConspects() {
  const all = BUCKET ? await gcsList() : await fsList();
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Краткая карточка для списка (без сырого текста и извлечения). */
export function summary(rec) {
  return {
    id: rec.id,
    status: rec.status,
    source: rec.source,
    fileName: rec.fileName,
    date: rec.date,
    participants: rec.participants,
    subjectType: rec.subjectType,
    subjectId: rec.subjectId,
    subjectName: rec.subjectName,
    themes: rec.extracted?.themes?.length || 0,
    draftCount: rec.draftTasks?.length || 0,
    createdCount: rec.createdTasks?.length || 0,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}
