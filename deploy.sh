#!/usr/bin/env bash
set -euo pipefail

HOST="goodboy"

# Guard: must be on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: deploy must run from main, currently on '$CURRENT_BRANCH'"
  exit 1
fi

echo "Deploying goodboy to EC2..."

echo "Pushing to origin..."
git push origin main

echo "Pulling and building on EC2..."
ssh "$HOST" bash -s << 'EOF'
set -euo pipefail
cd ~/goodboy

git pull --ff-only
npm ci --omit=dev
npm run build
npm run db:migrate

sudo systemctl restart goodboy

for i in {1..10}; do
  sleep 1
  if sudo systemctl is-active --quiet goodboy; then
    echo "Deploy successful -- goodboy is running"
    exit 0
  fi
done
echo "Deploy FAILED -- check logs with: sudo journalctl -u goodboy -n 50"
exit 1
EOF
