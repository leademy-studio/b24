#!/usr/bin/env bash
#
# Провижининг секретов T-Bank в Secret Manager и привязка к Cloud Run.
# Зеркало scripts/provision-auth.sh. Идемпотентно.
#
#   - TBANK_WEBHOOK_SECRET  (Bearer-секрет вебхука; генерируется, если нет)
#   - TBANK_TOKEN           (API-токен T-Business; берётся из .secrets/dashboard-admin.txt
#                            строки TBANK_TOKEN=... либо из env TBANK_TOKEN)
#
# Запуск:  bash scripts/provision-tbank.sh
# По умолчанию НЕ включает боевой режим: на сервис ставится TBANK_DRYRUN=true.
# Боевой режим (после сверки и регистрации вебхука у T-Bank):
#   TBANK_DRYRUN=false bash scripts/provision-tbank.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-midyear-reactor-441919-p4}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${SERVICE_NAME:-leademy-dashboard}"
SA="${RUNTIME_SA:-b24-dashboard@${PROJECT}.iam.gserviceaccount.com}"
DRYRUN="${TBANK_DRYRUN:-true}"
CRED_FILE="${CRED_FILE:-.secrets/dashboard-admin.txt}"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable secretmanager.googleapis.com run.googleapis.com >/dev/null

ensure_secret() { # name value
  local name="$1" value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    echo "==> Секрет $name уже есть — переиспользую."
  else
    echo "==> Создаю секрет $name..."
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
  fi
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
}

# --- TBANK_WEBHOOK_SECRET: генерируем, если ещё нет ---
if gcloud secrets describe TBANK_WEBHOOK_SECRET >/dev/null 2>&1; then
  ensure_secret TBANK_WEBHOOK_SECRET ""  # value игнорируется (секрет уже есть)
else
  GEN="$(openssl rand -hex 32)"
  ensure_secret TBANK_WEBHOOK_SECRET "$GEN"
  echo "==> Сгенерирован Bearer вебхука (передать T-Bank при регистрации):"
  echo "    $GEN"
fi

# --- TBANK_TOKEN: из env или из CRED_FILE (строка TBANK_TOKEN=...) ---
TOKEN="${TBANK_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$CRED_FILE" ]]; then
  TOKEN="$(grep -E '^TBANK_TOKEN=' "$CRED_FILE" | head -1 | cut -d= -f2-)"
fi
if [[ -n "$TOKEN" ]]; then
  ensure_secret TBANK_TOKEN "$TOKEN"
else
  echo "==> WARNING: TBANK_TOKEN не найден (ни env, ни в $CRED_FILE). Нужен только для опроса выписки."
fi

# --- Привязка секретов + флаг режима на Cloud Run ---
SET_SECRETS="TBANK_WEBHOOK_SECRET=TBANK_WEBHOOK_SECRET:latest"
gcloud secrets describe TBANK_TOKEN >/dev/null 2>&1 && SET_SECRETS+=",TBANK_TOKEN=TBANK_TOKEN:latest"

echo "==> Привязываю секреты и ставлю TBANK_DRYRUN=$DRYRUN на сервис $SERVICE..."
gcloud run services update "$SERVICE" --region "$REGION" \
  --update-secrets "$SET_SECRETS" \
  --update-env-vars "TBANK_DRYRUN=${DRYRUN}" >/dev/null

cat <<EOF

==> Готово.  TBANK_DRYRUN=$DRYRUN
    Вебхук:   $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')/api/tbank/webhook
    Дальше: зарегистрировать вебхук у T-Bank (письмо openapi@tbank.ru: ИНН 7203566588,
            URL вебхука, Authorization: Bearer <TBANK_WEBHOOK_SECRET>).
    Боевой режим после сверки:  TBANK_DRYRUN=false bash scripts/provision-tbank.sh
EOF
