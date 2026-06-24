#!/usr/bin/env node
/**
 * Локальный dry-run генератора месячных рутинных задач — без HTTP/OIDC.
 *
 * Запуск:  node --env-file=.env scripts/dry-run-month.mjs [YYYY-MM]
 * Пример:  node --env-file=.env scripts/dry-run-month.mjs 2026-07
 *
 * Ничего на портале не создаёт (dryRun=true). Печатает дерево «проект →
 * услуги → родители + подзадачи» и сводку — для сверки с автоматикой Bitrix.
 */
import { runLaunchMonth } from "../dashboard/scheduler.js";

const period = process.argv[2]; // undefined → текущий месяц

const result = await runLaunchMonth({ period, dryRun: true });

const { summary, monthLabel, deadline } = result;
console.log(`\n=== launch-month DRY-RUN · ${result.period} (${monthLabel}) ===`);
console.log(`Дедлайн родителей: ${deadline.iso}${deadline.calendarFallback ? "  [календарь: фолбэк сб/вс]" : ""}`);
console.log(
  `Сделок: ${summary.deals} | родителей к созданию: ${summary.parentsPlanned} | ` +
    `подзадач: ${summary.subtasksPlanned} | пропущено (уже есть): ${summary.skipped} | ошибок: ${summary.errors}\n`
);

for (const p of result.projects) {
  const head = `• [сделка ${p.dealId} / группа ${p.groupId ?? "—"}] ${p.project}`;
  console.log(head);
  if (p.error) console.log(`    ОШИБКА: ${p.error}`);
  for (const s of p.services) {
    console.log(`    └─ ${s.parentTitle}  (отв. ${s.responsibleId})${s.note ? "  — " + s.note : ""}`);
    for (const t of s.subtasks) {
      const acc = t.accomplices?.length ? ` +соисп.${t.accomplices.join(",")}` : "";
      console.log(`         · ${t.title}  (отв. ${t.responsibleId}${acc})`);
    }
  }
  for (const sk of p.skipped) {
    console.log(`    ⤫ пропуск (уже есть #${sk.existingTaskId}): ${sk.parentTitle}`);
  }
}

if (result.errors.length) {
  console.log(`\nОшибки (${result.errors.length}):`);
  for (const e of result.errors) console.log(`  сделка ${e.dealId}: ${e.error}`);
}
console.log("");
