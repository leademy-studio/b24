#!/usr/bin/env node
/**
 * Локальный dry-run недельного генератора PPC-подзадач — без HTTP/OIDC.
 *
 * Запуск:
 *   node --env-file=.env scripts/dry-run-weekly.mjs optimization   # №10
 *   node --env-file=.env scripts/dry-run-weekly.mjs feedback        # №11
 *   node --env-file=.env scripts/dry-run-weekly.mjs                 # по дню недели
 *
 * Ничего не создаёт (dryRun=true). Печатает, что было бы создано под текущим
 * месячным PPC-родителем каждого активного PPC-проекта.
 */
import { runLaunchWeekly } from "../dashboard/weekly.js";

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith("--")); // optimization | feedback | undefined
const pi = args.indexOf("--period");
const period = pi >= 0 ? args[pi + 1] : undefined; // YYYY-MM (месяц PPC-родителя)
const r = await runLaunchWeekly({ kind, period, dryRun: true });

console.log(`\n=== launch-weekly DRY-RUN · виды: [${r.kinds.join(", ") || "—"}] · неделя ${r.weekLabel} ===`);
if (r.note) console.log(`(${r.note})`);
console.log(`Месяц-родитель: ${r.monthLabel} | дедлайн: ${r.deadline}`);
console.log(
  `PPC-сделок: ${r.summary.deals} | к созданию: ${r.summary.created} (dry-run) | пропущено: ${r.summary.skipped} | ошибок: ${r.summary.errors}\n`
);

for (const p of r.projects) {
  const planned = p.created.length;
  const skip = p.skipped.map((s) => s.reason).join(",");
  if (!planned && !p.skipped.length && !p.error) continue;
  console.log(`• [сделка ${p.dealId} / группа ${p.groupId}] ${p.project}`);
  if (p.error) console.log(`    ОШИБКА: ${p.error}`);
  for (const c of p.created) console.log(`    + ${c.title}  (отв. ${c.responsibleId} +соисп.${(c.accomplices || []).join(",")})`);
  for (const s of p.skipped) console.log(`    ⤫ ${s.kind || ""} ${s.reason}${s.title ? " — " + s.title : ""}${s.parentTitle ? " — " + s.parentTitle : ""}`);
}
console.log("\nГотово (dryRun, ничего не создано).");
