#!/usr/bin/env bash
#
# Деплой каркаса дашборда Leademy в Cloud Run.
# Проект: существующий midyear-reactor-441919-p4 (см. memory owner-dashboard-project).
#
# Перед запуском: gcloud auth login  (активный токен мог протухнуть).
# Запуск:        bash scripts/deploy-dashboard.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-midyear-reactor-441919-p4}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${SERVICE_NAME:-leademy-dashboard}"
SA="${RUNTIME_SA:-b24-dashboard@${PROJECT}.iam.gserviceaccount.com}"
SECRET_NAME="${SECRET_NAME:-B24_WEBHOOK_BASE}"

echo "==> Проект:   $PROJECT"
echo "==> Регион:   $REGION"
echo "==> Сервис:   $SERVICE"
echo "==> Runtime SA: $SA"

gcloud config set project "$PROJECT" >/dev/null

echo "==> Включаю необходимые API (идемпотентно)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# --- Секрет B24_WEBHOOK_BASE (берём из локального .env, если секрета ещё нет) ---
SECRETS=()
if gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
  echo "==> Секрет $SECRET_NAME уже существует — переиспользую."
  SECRETS+=("B24_WEBHOOK_BASE=${SECRET_NAME}:latest")
elif [[ -f .env ]] && grep -q '^B24_WEBHOOK_BASE=' .env; then
  echo "==> Создаю секрет $SECRET_NAME из .env..."
  grep '^B24_WEBHOOK_BASE=' .env | head -1 | cut -d= -f2- | tr -d '"' \
    | gcloud secrets create "$SECRET_NAME" --data-file=- --replication-policy=automatic
  SECRETS+=("B24_WEBHOOK_BASE=${SECRET_NAME}:latest")
else
  echo "==> WARNING: секрет $SECRET_NAME не найден и B24_WEBHOOK_BASE нет в .env."
fi

# --- Секреты аутентификации (создаются один раз скриптом provision-auth.sh) ---
for s in DASHBOARD_PASSWORD_HASH SESSION_SECRET; do
  if gcloud secrets describe "$s" >/dev/null 2>&1; then
    SECRETS+=("$s=$s:latest")
  else
    echo "==> WARNING: секрет $s не найден — запусти scripts/provision-auth.sh (вход не заработает)."
  fi
done

# --- Логин администратора (НЕ секрет) — из .env USERNAME ---
DASH_USER="$(grep '^USERNAME=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
# ВАЖНО: используем --update-* (аддитивно), а не --set-* (заменяет весь набор),
# чтобы деплой НЕ стирал env/секреты, проставленные provision-scheduler/provision-tbank
# (CRON_SA_EMAIL, CRON_AUDIENCE, TBANK_*, TBANK_DRYRUN и т.п.).
ENV_FLAG=()
[[ -n "$DASH_USER" ]] && ENV_FLAG=(--update-env-vars "DASHBOARD_USERNAME=${DASH_USER}")

SECRET_FLAG=()
[[ ${#SECRETS[@]} -gt 0 ]] && SECRET_FLAG=(--update-secrets "$(IFS=,; echo "${SECRETS[*]}")")

echo "==> Деплой в Cloud Run (--source, Cloud Build соберёт по Dockerfile)..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 512Mi \
  --min-instances 0 --max-instances 2 \
  "${ENV_FLAG[@]}" \
  "${SECRET_FLAG[@]}"

echo
echo "==> Готово. URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
echo "==> Проверка: curl -s <URL>/api/health"
