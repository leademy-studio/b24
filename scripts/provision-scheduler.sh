#!/usr/bin/env bash
#
# Провижининг Cloud Scheduler для месячного генератора рутинных задач
# (POST /api/cron/launch-month). По умолчанию — БЕЗОПАСНО:
#   - джоб создаётся НА ПАУЗЕ (PAUSE=1)
#   - тело запроса dryRun=true (DRYRUN=true) — даже сработав, ничего не создаёт
#
# Что делает (идемпотентно):
#   1. включает API Cloud Scheduler
#   2. создаёт сервис-аккаунт планировщика (если нет) и даёт ему run.invoker
#   3. прописывает в Cloud Run env CRON_SA_EMAIL + CRON_AUDIENCE (для проверки OIDC)
#   4. создаёт/обновляет джоб leademy-launch-month (1-го числа ~00:05 МСК)
#
# ВНИМАНИЕ: сначала задеплойте новый код (есть cron-auth.js/scheduler.js):
#   bash scripts/deploy-dashboard.sh
#
# Запуск (безопасно, на паузе, dry-run):
#   bash scripts/provision-scheduler.sh
#
# БОЕВОЕ включение (ТОЛЬКО после отключения роботов Bitrix и сверки dry-run):
#   DRYRUN=false PAUSE=0 bash scripts/provision-scheduler.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-midyear-reactor-441919-p4}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${SERVICE_NAME:-leademy-dashboard}"
SCHED_SA_NAME="${SCHEDULER_SA_NAME:-b24-scheduler}"
SCHED_SA="${SCHED_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
JOB="${JOB_NAME:-leademy-launch-month}"
SCHEDULE="${SCHEDULE:-5 0 1 * *}"          # 1-го числа в 00:05
TZ_NAME="${TZ_NAME:-Europe/Moscow}"
DRYRUN="${DRYRUN:-true}"                     # true = безопасно (ничего не создаёт)
PAUSE="${PAUSE:-1}"                          # 1 = создать на паузе

echo "==> Проект:   $PROJECT / регион $REGION"
echo "==> Сервис:   $SERVICE"
echo "==> SA планировщика: $SCHED_SA"
echo "==> Джоб:     $JOB  (cron '$SCHEDULE' $TZ_NAME)  dryRun=$DRYRUN  pause=$PAUSE"

gcloud config set project "$PROJECT" >/dev/null

echo "==> Включаю API Cloud Scheduler (идемпотентно)..."
gcloud services enable cloudscheduler.googleapis.com iam.googleapis.com >/dev/null

# --- Сервис-аккаунт планировщика ---
if ! gcloud iam service-accounts describe "$SCHED_SA" >/dev/null 2>&1; then
  echo "==> Создаю SA $SCHED_SA..."
  gcloud iam service-accounts create "$SCHED_SA_NAME" \
    --display-name="Leademy Cloud Scheduler (launch-month)"
else
  echo "==> SA уже есть — переиспользую."
fi

# --- URL сервиса Cloud Run ---
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
if [[ -z "$URL" ]]; then
  echo "✗ Не найден сервис $SERVICE в $REGION. Сначала: bash scripts/deploy-dashboard.sh" >&2
  exit 1
fi
echo "==> URL сервиса: $URL"

# --- Право вызывать Cloud Run (на случай ужесточения --no-allow-unauthenticated) ---
echo "==> Даю SA роль run.invoker на сервис..."
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" \
  --member="serviceAccount:${SCHED_SA}" \
  --role="roles/run.invoker" >/dev/null

# --- Прописываем в Cloud Run env для проверки OIDC в приложении (cron-auth.js) ---
echo "==> Обновляю env сервиса: CRON_SA_EMAIL, CRON_AUDIENCE (новая ревизия)..."
gcloud run services update "$SERVICE" --region "$REGION" \
  --update-env-vars "CRON_SA_EMAIL=${SCHED_SA},CRON_AUDIENCE=${URL}" >/dev/null

# --- Создание/обновление джоба ---
BODY="{\"dryRun\": ${DRYRUN}}"
COMMON_ARGS=(
  --location "$REGION"
  --schedule "$SCHEDULE"
  --time-zone "$TZ_NAME"
  --uri "${URL}/api/cron/launch-month"
  --http-method POST
  --headers "Content-Type=application/json"
  --message-body "$BODY"
  --oidc-service-account-email "$SCHED_SA"
  --oidc-token-audience "$URL"
  --attempt-deadline "320s"
)

if gcloud scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  echo "==> Джоб существует — обновляю..."
  gcloud scheduler jobs update http "$JOB" "${COMMON_ARGS[@]}"
else
  echo "==> Создаю джоб..."
  gcloud scheduler jobs create http "$JOB" "${COMMON_ARGS[@]}"
fi

if [[ "$PAUSE" == "1" ]]; then
  echo "==> Ставлю джоб НА ПАУЗУ (безопасно)."
  gcloud scheduler jobs pause "$JOB" --location "$REGION" >/dev/null
else
  echo "==> Джоб АКТИВЕН (PAUSE=0)."
fi

cat <<EOF

==> Готово.
    Джоб:    $JOB  (dryRun=$DRYRUN, $([[ "$PAUSE" == "1" ]] && echo "на паузе" || echo "активен"))
    Эндпоинт: ${URL}/api/cron/launch-month

    Проверить вручную (выполнит запрос сейчас, с телом dryRun=$DRYRUN):
      gcloud scheduler jobs run $JOB --location $REGION

    БОЕВОЕ включение (строго ПОСЛЕ отключения роботов Bitrix и сверки dry-run):
      DRYRUN=false PAUSE=0 bash scripts/provision-scheduler.sh
EOF
