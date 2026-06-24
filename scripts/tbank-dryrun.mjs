#!/usr/bin/env node
/**
 * Сверка матчера платежей T-Bank на синтетических операциях поверх РЕАЛЬНЫХ сделок.
 * Ничего в CRM не двигает (dryRun=true). Только читает crm.deal.get / requisite.
 *
 * Запуск:  node --env-file=.env scripts/tbank-dryrun.mjs
 *
 * По умолчанию гоняет встроенные кейсы. Чтобы проверить конкретный платёж:
 *   node --env-file=.env scripts/tbank-dryrun.mjs --inn 772310853052 --amount 19000 --purpose "Оплата по счету №127-747-06-2026"
 */
import { matchPayment, _resetSeen, OWN_INN } from "../dashboard/payments-matcher.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function op(over = {}) {
  return {
    operationId: over.operationId ?? "op-" + Math.random().toString(36).slice(2, 8),
    direction: "credit",
    amount: 19000,
    currency: "RUB",
    payerInn: "772310853052",
    payerName: "ИП Сопкина",
    purpose: "Оплата по счету №127-747-06-2026 от 01.06.2026 НДС не облагается",
    date: "2026-06-24",
    ...over,
  };
}

async function run(label, o) {
  _resetSeen();
  const d = await matchPayment(o, { dryRun: true });
  const extra = [d.dealId && `deal=${d.dealId}`, d.expected != null && `expected=${d.expected}`, d.amount != null && `amount=${d.amount}`, d.candidates && `cands=[${d.candidates}]`]
    .filter(Boolean)
    .join(" ");
  console.log(`  ${label.padEnd(28)} → ${String(d.action).toUpperCase().padEnd(7)} ${d.reason || ""}  ${extra}`);
  return d;
}

// Кастомный одиночный прогон
if (process.argv.includes("--inn") || process.argv.includes("--purpose")) {
  const o = op({
    payerInn: arg("inn", "772310853052"),
    amount: Number(arg("amount", "19000")),
    purpose: arg("purpose", op().purpose),
  });
  console.log("Кастомный платёж:");
  await run("custom", o);
  process.exit(0);
}

console.log("=== Сверка матчера T-Bank (dry-run, реальные сделки) ===");
console.log("Кейсы (deal 747 / company 127 / INN 772310853052 / OPP 19000):\n");

await run("1. полная оплата", op());
await run("2. частичная оплата", op({ amount: 1000 }));
await run("3. чужой ИНН", op({ payerInn: "0000000000" }));
await run("4. не NEW (deal 97 EXEC)", op({ purpose: "Оплата по счету №9-97-06-2026" }));
await run("5. свой ИНН (агентство)", op({ payerInn: OWN_INN }));
await run("6. дебет (исходящий)", op({ direction: "debit" }));
await run("7. фолбэк по ИНН (без номера)", op({ purpose: "Оплата за услуги без номера счета" }));

console.log("\nГотово. Сделки НЕ двигались (dryRun).");
