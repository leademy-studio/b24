#!/usr/bin/env bash
#
# Одноразовый провижининг секретов аутентификации дашборда в Secret Manager:
#   - DASHBOARD_PASSWORD_HASH  (scrypt-хэш пароля из .secrets/dashboard-admin.txt)
#   - SESSION_SECRET           (случайный ключ подписи сессий)
# и выдача runtime-SA права secretAccessor на них.
#
# Запуск: bash scripts/provision-auth.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-midyear-reactor-441919-p4}"
SA="${RUNTIME_SA:-b24-dashboard@${PROJECT}.iam.gserviceaccount.com}"
CRED_FILE="${CRED_FILE:-.secrets/dashboard-admin.txt}"

gcloud config set project "$PROJECT" >/dev/null

# scrypt-хэш пароля (пароль НЕ печатается в stdout)
HASH="$(node -e '
const crypto=require("crypto"),fs=require("fs");
const txt=fs.readFileSync(process.argv[1],"utf8");
const m=txt.match(/Пароль:\s*(\S+)/);
if(!m){console.error("Пароль не найден в "+process.argv[1]);process.exit(1);}
const salt=crypto.randomBytes(16);
const hash=crypto.scryptSync(m[1],salt,32);
process.stdout.write("scrypt$"+salt.toString("hex")+"$"+hash.toString("hex"));
' "$CRED_FILE")"

upsert_secret() {
  local name="$1"; local value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=-
    echo "==> Обновлён секрет $name (новая версия)"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
    echo "==> Создан секрет $name"
  fi
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
  echo "==> Право secretAccessor выдано $SA на $name"
}

upsert_secret "DASHBOARD_PASSWORD_HASH" "$HASH"
upsert_secret "SESSION_SECRET" "$(openssl rand -hex 32)"

echo "==> Готово. Теперь: bash scripts/deploy-dashboard.sh"
