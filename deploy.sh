#!/usr/bin/env bash
set -euo pipefail

HOST="goodboy"
APP_DIR="~/goodboy"

echo "Deploying goodboy to EC2..."

# Push latest code
echo "Pushing to origin..."
git push origin main

# Deploy on remote
echo "Pulling and building on EC2..."
ssh "$HOST" bash -s << 'EOF'
set -euo pipefail
cd ~/goodboy

git pull --ff-only
npm install
npm run build

sudo systemctl restart goodboy
sleep 2

if sudo systemctl is-active --quiet goodboy; then
  echo "Deploy successful — goodboy is running"
else
  echo "Deploy FAILED — check logs with: sudo journalctl -u goodboy -n 50"
  exit 1
fi
EOF
