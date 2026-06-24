#!/usr/bin/env node
/**
 * Идемпотентно заводит в сделках поле «Площадки PPC» (мультисписок),
 * которое читает генератор dashboard/scheduler.js (UF_CRM_PPC_PLATFORMS).
 *
 * Запуск:  node --env-file=.env scripts/setup-ppc-field.mjs
 *
 * Повторный запуск безопасен: если поле уже есть — печатает его enum-значения и выходит.
 */
import { b24Call } from "../dashboard/bitrix24.js";

const FIELD_NAME = "PPC_PLATFORMS"; // хранится как UF_CRM_PPC_PLATFORMS
const STORED_NAME = "UF_CRM_PPC_PLATFORMS";

const VALUES = [
  { VALUE: "Яндекс Директ", XML_ID: "ppc_yandex_direct", SORT: 100, DEF: "N" },
  { VALUE: "Google Ads", XML_ID: "ppc_google_ads", SORT: 200, DEF: "N" },
  { VALUE: "ВКонтакте", XML_ID: "ppc_vk", SORT: 300, DEF: "N" },
];

async function existing() {
  const data = await b24Call("crm.deal.userfield.list", {
    filter: { FIELD_NAME: STORED_NAME },
  });
  return (data.result || [])[0] || null;
}

const found = await existing();
if (found) {
  console.log(`Поле ${STORED_NAME} уже существует (ID ${found.ID}). Значения:`);
  for (const e of found.LIST || []) console.log(`  ${e.ID} = ${e.VALUE} (${e.XML_ID})`);
  console.log("Ничего не меняю.");
  process.exit(0);
}

const res = await b24Call("crm.deal.userfield.add", {
  fields: {
    FIELD_NAME,
    USER_TYPE_ID: "enumeration",
    MULTIPLE: "Y",
    MANDATORY: "N",
    SHOW_FILTER: "Y",
    SHOW_IN_LIST: "Y",
    EDIT_IN_LIST: "Y",
    LABEL: "Площадки PPC",
    LIST_COLUMN_LABEL: "Площадки PPC",
    EDIT_FORM_LABEL: "Площадки PPC",
    LIST_FILTER_LABEL: "Площадки PPC",
    HELP_MESSAGE: "Площадки контекстной рекламы — по одной задаче «Запуск рекламной активности» на каждую при автогенерации месяца.",
    SETTINGS: { DISPLAY: "UI" },
    LIST: VALUES,
    SORT: 600,
  },
});

const id = res.result;
console.log(`Создано поле ${STORED_NAME} (ID ${id}).`);

// Печать enum-значений (ID нужны генератору для маппинга)
const check = await existing();
console.log("Значения списка:");
for (const e of check?.LIST || []) console.log(`  ${e.ID} = ${e.VALUE} (${e.XML_ID})`);
console.log(
  "\nДальше: заполните поле «Площадки PPC» в нужных сделках воронки «Производство». " +
    "Пустое поле → генератор использует фолбэк «Яндекс Директ»."
);
