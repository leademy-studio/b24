#!/usr/bin/env bash
#
# Статический исходящий IP для Cloud Run (нужен для IP-привязанного токена T-Bank).
# Создаёт: зарезервированный IP + Serverless VPC-коннектор + Cloud Router + Cloud NAT,
# и маршрутизирует весь egress сервиса через них. Идемпотентно.
#
# ⚠️ Добавляет регулярную плату GCP (Cloud NAT + коннектор + статический IP).
#
# Запуск:  bash scripts/provision-egress.sh
# Откатить egress у сервиса (трафик снова через динамические IP Google):
#   gcloud run services update leademy-dashboard --region europe-west1 --clear-vpc-connector
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-midyear-reactor-441919-p4}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${SERVICE_NAME:-leademy-dashboard}"
NETWORK="${VPC_NETWORK:-tg}"
CONNECTOR="${CONNECTOR_NAME:-b24-egress}"
CONNECTOR_RANGE="${CONNECTOR_RANGE:-10.8.0.0/28}"   # /28 не пересекается с tg (10.0.1.0/24)
IP_NAME="${EGRESS_IP_NAME:-b24-egress-ip}"
ROUTER="${ROUTER_NAME:-b24-egress-router}"
NAT="${NAT_NAME:-b24-egress-nat}"

echo "==> Проект $PROJECT / регион $REGION / сеть $NETWORK"
gcloud config set project "$PROJECT" >/dev/null

echo "==> Включаю API (vpcaccess, compute)..."
gcloud services enable vpcaccess.googleapis.com compute.googleapis.com >/dev/null

# --- 1. Зарезервированный статический внешний IP ---
if gcloud compute addresses describe "$IP_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Статический IP $IP_NAME уже есть."
else
  echo "==> Резервирую статический IP $IP_NAME..."
  gcloud compute addresses create "$IP_NAME" --region "$REGION"
fi
EGRESS_IP="$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"
echo "    IP: $EGRESS_IP"

# --- 2. Serverless VPC Access connector ---
if gcloud compute networks vpc-access connectors describe "$CONNECTOR" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Коннектор $CONNECTOR уже есть."
else
  echo "==> Создаю VPC-коннектор $CONNECTOR ($CONNECTOR_RANGE)..."
  gcloud compute networks vpc-access connectors create "$CONNECTOR" \
    --region "$REGION" --network "$NETWORK" --range "$CONNECTOR_RANGE" \
    --min-instances 2 --max-instances 3 --machine-type e2-micro
fi

# --- 3. Cloud Router ---
if gcloud compute routers describe "$ROUTER" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Роутер $ROUTER уже есть."
else
  echo "==> Создаю Cloud Router $ROUTER..."
  gcloud compute routers create "$ROUTER" --region "$REGION" --network "$NETWORK"
fi

# --- 4. Cloud NAT с фиксированным IP ---
if gcloud compute routers nats describe "$NAT" --router "$ROUTER" --region "$REGION" >/dev/null 2>&1; then
  echo "==> NAT $NAT уже есть — обновляю IP-пул..."
  gcloud compute routers nats update "$NAT" --router "$ROUTER" --region "$REGION" \
    --nat-all-subnet-ip-ranges --nat-external-ip-pool "$IP_NAME"
else
  echo "==> Создаю Cloud NAT $NAT (egress через $IP_NAME)..."
  gcloud compute routers nats create "$NAT" --router "$ROUTER" --region "$REGION" \
    --nat-all-subnet-ip-ranges --nat-external-ip-pool "$IP_NAME"
fi

# --- 5. Маршрутизация egress Cloud Run через коннектор ---
echo "==> Привязываю сервис $SERVICE к коннектору (egress=all-traffic, новая ревизия)..."
gcloud run services update "$SERVICE" --region "$REGION" \
  --vpc-connector "$CONNECTOR" --vpc-egress all-traffic >/dev/null

cat <<EOF

==> Готово. Статический исходящий IP: $EGRESS_IP
    Зарегистрируйте этот IP при выпуске токена T-Bank (T-Business → API-токены).
    Проверка фактического egress-IP сервиса:
      curl -s -H "Cookie: <сессия>" <URL>/api/egress-ip
EOF
