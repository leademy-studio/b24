#!/usr/bin/env bash
#
# Провижининг Cloud Scheduler для генераторов рутинных задач. По умолчанию БЕЗОПАСНО:
#   - джобы создаются НА ПАУЗЕ (PAUSE=1)
#   - тело запроса dryRun=true (DRYRUN=true) — даже сработав, ничего не создают
#
# Что делает (идемпотентно):
#   1. включает API Cloud Scheduler
#   2. создаёт сервис-аккаунт планировщика (если нет) и даёт ему run.invoker
#   3. прописывает в Cloud Run env CRON_SA_EMAIL + CRON_AUDIENCE (для проверки OIDC)
#   4. создаёт/обновляет 3 джоба:
#      - leademy-launch-month       → /api/cron/launch-month  (1-го числа ~00:05 МСК)
#      - leademy-launch-weekly-opt  → /api/cron/launch-weekly kind=optimization (ср ~06:00)
#      - leademy-launch-weekly-fb   → /api/cron/launch-weekly kind=feedback (пн ~06:00)
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

# Расписания недельных джобов (МСК): №10 ср, №11 пн (~06:00). См. ТЗ §8.1.
WEEKLY_OPT_SCHEDULE="${WEEKLY_OPT_SCHEDULE:-0 6 * * 3}"  # среда 06:00
WEEKLY_FB_SCHEDULE="${WEEKLY_FB_SCHEDULE:-0 6 * * 1}"    # понедельник 06:00

# --- helper: idempotent upsert одного http-джоба + пауза/резюм по PAUSE ---
upsert_job() { # name schedule endpoint body
  local name="$1" schedule="$2" endpoint="$3" body="$4"
  # Общие флаги без заголовка: create принимает --headers, update — --update-headers.
  local args=(
    --location "$REGION"
    --schedule "$schedule"
    --time-zone "$TZ_NAME"
    --uri "${URL}${endpoint}"
    --http-method POST
    --message-body "$body"
    --oidc-service-account-email "$SCHED_SA"
    --oidc-token-audience "$URL"
    --attempt-deadline "320s"
  )
  if gcloud scheduler jobs describe "$name" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" "${args[@]}" --update-headers "Content-Type=application/json" >/dev/null
    echo "==> Джоб $name обновлён  (cron '$schedule')"
  else
    gcloud scheduler jobs create http "$name" "${args[@]}" --headers "Content-Type=application/json" >/dev/null
    echo "==> Джоб $name создан  (cron '$schedule')"
  fi
  if [[ "$PAUSE" == "1" ]]; then
    gcloud scheduler jobs pause "$name" --location "$REGION" >/dev/null
    echo "    $name → НА ПАУЗЕ (dryRun=$DRYRUN)"
  else
    gcloud scheduler jobs resume "$name" --location "$REGION" >/dev/null 2>&1 || true
    echo "    $name → АКТИВЕН (dryRun=$DRYRUN)"
  fi
}

upsert_job "$JOB" "$SCHEDULE" "/api/cron/launch-month" "{\"dryRun\": ${DRYRUN}}"
upsert_job "leademy-launch-weekly-opt" "$WEEKLY_OPT_SCHEDULE" "/api/cron/launch-weekly" "{\"kind\":\"optimization\",\"dryRun\": ${DRYRUN}}"
upsert_job "leademy-launch-weekly-fb" "$WEEKLY_FB_SCHEDULE" "/api/cron/launch-weekly" "{\"kind\":\"feedback\",\"dryRun\": ${DRYRUN}}"

cat <<EOF

==> Готово (dryRun=$DRYRUN, $([[ "$PAUSE" == "1" ]] && echo "все на паузе" || echo "все активны")).
    Месячный:  $JOB                 → /api/cron/launch-month  ('$SCHEDULE')
    Недельный: leademy-launch-weekly-opt → /api/cron/launch-weekly kind=optimization ('$WEEKLY_OPT_SCHEDULE')
    Недельный: leademy-launch-weekly-fb  → /api/cron/launch-weekly kind=feedback ('$WEEKLY_FB_SCHEDULE')

    Проверить вручную (выполнит запрос сейчас, тело dryRun=$DRYRUN):
      gcloud scheduler jobs run $JOB --location $REGION

    БОЕВОЕ включение (строго ПОСЛЕ отключения роботов Bitrix и сверки dry-run):
      DRYRUN=false PAUSE=0 bash scripts/provision-scheduler.sh
EOF
