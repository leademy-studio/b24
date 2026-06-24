/**
 * Матчер входящих платежей T-Bank → авто-перевод сделки NEW → EXECUTING (ТЗ §9).
 *
 * matchPayment(op, {dryRun}) принимает НОРМАЛИЗОВАННУЮ операцию (см. tbank.js):
 *   { operationId, direction:"credit"|"debit", amount:Number, currency,
 *     payerInn:String, payerName, purpose:String, date }
 * и возвращает решение { action, reason, ... }. При dryRun=false и action="move"
 * двигает сделку crm.deal.update STAGE_ID=EXECUTING.
 *
 * dryRun по умолчанию true — fail-safe: ничего не двигаем, пока не сверим.
 */

import {
  dealGet,
  dealUpdateStage,
  companyInn,
  companyByInn,
  newDealsByCompany,
  imNotifyOwner,
} from "./bitrix24.js";

export const OWN_INN = "7203566588"; // ООО «ЛИДЕМИ» — свои переводы пропускаем
const CATEGORY_ID = 0;
const STAGE_NEW = "NEW";
const STAGE_EXECUTING = "EXECUTING";
const SUBCONTRACT_FIELD = "UF_CRM_SUBCONTRACT";
const OWNER_DIALOG_ID = 131;

// Номер счёта в назначении: «№115-1119-06-2026» → COMPANY-DEAL-MM-YYYY
const INVOICE_RE = /№\s*(\d+)-(\d+)-(\d{2})-(\d{4})/;

// In-memory дедуп обработанных operationId (durable Firestore — позже).
const seenOps = new Set();

function num(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function isSubcontract(deal) {
  const v = deal[SUBCONTRACT_FIELD];
  return v === "1" || v === 1 || v === "Y" || v === true;
}

/** Решение по сделке-кандидату: проверки стадии/компании/суммы. */
function evaluateDeal(deal, { payerInn, amount, expectedCompanyId }) {
  if (!deal) return { action: "manual", reason: "deal_not_found" };
  const dealId = Number(deal.ID);
  if (Number(deal.CATEGORY_ID) !== CATEGORY_ID)
    return { action: "skip", reason: "not_category_0", dealId };
  if (deal.STAGE_ID !== STAGE_NEW)
    return { action: "skip", reason: `not_new_stage(${deal.STAGE_ID})`, dealId };
  if (isSubcontract(deal))
    return { action: "skip", reason: "subcontract_deal", dealId };
  if (expectedCompanyId != null && Number(deal.COMPANY_ID) !== Number(expectedCompanyId))
    return { action: "manual", reason: "company_mismatch", dealId };
  return { action: "ok", dealId, companyId: Number(deal.COMPANY_ID), opportunity: num(deal.OPPORTUNITY) };
}

/** Проверка суммы: полная оплata двигает, частичная — нет. */
function amountDecision(amount, opportunity, base) {
  if (opportunity > 0 && amount < opportunity)
    return { action: "skip", reason: "partial_payment", expected: opportunity, amount, ...base };
  return { action: "move", reason: "full_payment", amount, expected: opportunity, ...base };
}

/**
 * Основной матчер.
 * @param {object} op нормализованная операция
 * @param {object} opts { dryRun=true }
 */
export async function matchPayment(op, { dryRun = true } = {}) {
  const tag = { operationId: op.operationId, payerInn: op.payerInn, amount: op.amount };

  // 1. только входящие
  if (op.direction !== "credit")
    return { action: "skip", reason: "not_credit", ...tag };
  // свои переводы
  if (String(op.payerInn) === OWN_INN)
    return { action: "skip", reason: "own_inn", ...tag };

  // 2. дедуп по operationId
  if (op.operationId != null && seenOps.has(op.operationId))
    return { action: "skip", reason: "duplicate_operation", ...tag };

  let decision;

  // 3. парсинг номера счёта из назначения
  const m = INVOICE_RE.exec(op.purpose || "");
  if (m) {
    const clientId = Number(m[1]);
    const dealId = Number(m[2]);
    const deal = await dealGet(dealId);
    const ev = evaluateDeal(deal, { expectedCompanyId: clientId });
    if (ev.action !== "ok") {
      decision = { ...ev, ...tag, source: "invoice" };
    } else {
      // анти-фрод: ИНН плательщика == ИНН компании сделки
      const inn = await companyInn(clientId);
      if (!inn || inn !== String(op.payerInn)) {
        decision = { action: "manual", reason: "inn_mismatch", dealId, companyId: clientId, expectedInn: inn, ...tag, source: "invoice" };
      } else {
        decision = { ...amountDecision(op.amount, ev.opportunity, { dealId, companyId: clientId, source: "invoice" }), ...tag };
      }
    }
  } else {
    // фолбэк: ИНН → компания → единственная NEW-сделка
    const companies = await companyByInn(op.payerInn);
    if (companies.length === 0) {
      decision = { action: "manual", reason: "unknown_inn", ...tag, source: "fallback" };
    } else {
      const candidates = [];
      for (const cId of companies) {
        const deals = await newDealsByCompany(cId);
        for (const d of deals) if (!isSubcontract(d)) candidates.push(d);
      }
      if (candidates.length === 1) {
        const d = candidates[0];
        decision = { ...amountDecision(op.amount, num(d.OPPORTUNITY), { dealId: Number(d.ID), companyId: Number(d.COMPANY_ID), source: "fallback" }), ...tag };
      } else {
        decision = { action: "manual", reason: candidates.length === 0 ? "no_new_deal" : "ambiguous_multiple_deals", candidates: candidates.map((d) => Number(d.ID)), ...tag, source: "fallback" };
      }
    }
  }

  // 4. боевое движение
  if (decision.action === "move" && !dryRun) {
    try {
      const ok = await dealUpdateStage(decision.dealId, STAGE_EXECUTING);
      decision.moved = ok;
      if (!ok) decision.error = "deal_update_failed";
    } catch (e) {
      decision.action = "manual";
      decision.error = e.message || String(e);
    }
  }

  // дедуп-отметка только при фактической обработке (move/skip-после-проверок)
  if (op.operationId != null) seenOps.add(op.operationId);

  // алерт владельцу — только боевой режим, ручной разбор/ошибки
  if (!dryRun && (decision.action === "manual" || decision.error)) {
    const msg = `⚠️ T-Bank платёж не обработан автоматически (${decision.reason || decision.error}). ИНН ${op.payerInn}, сумма ${op.amount}, назначение: «${(op.purpose || "").slice(0, 80)}». Нужен ручной разбор.`;
    try {
      await imNotifyOwner(OWNER_DIALOG_ID, msg);
    } catch (e) {
      console.error("[matcher] alert failed:", e.message);
    }
  }

  return decision;
}

/** Сброс in-memory дедупа (для тестов/CLI). */
export function _resetSeen() {
  seenOps.clear();
}
