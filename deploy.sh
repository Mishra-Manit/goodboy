#!/usr/bin/env bash
set -euo pipefail

# Derive paths from this scripts location so it works on any host/user
PROJECT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SERVICE="goodboy"

echo "========================================"
echo "Starting Deployment: Goodboy"
echo "Project: $PROJECT_DIR"
echo "========================================"

cd "$PROJECT_DIR"

echo "Pulling latest code..."
git pull --ff-only

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Applying DB migrations..."
npm run db:migrate

echo "Restarting service..."
sudo systemctl restart "$SERVICE"

echo "Waiting for service to come up..."
for i in {1..10}; do
  sleep 1
  if sudo systemctl is-active --quiet "$SERVICE"; then
    echo "Deploy successful -- $SERVICE is running"
    exit 0
  fi
done
echo "Deploy FAILED -- check logs with: sudo journalctl -u $SERVICE -n 50"
exit 1
