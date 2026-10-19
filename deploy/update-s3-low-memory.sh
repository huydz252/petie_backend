#!/usr/bin/env bash
set -eu
cd /home/ubuntu/petie_backend
# Bound Node heap on a small EC2 instance; skip audit and install hooks during installation.
export NODE_OPTIONS='--max-old-space-size=192'
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/prisma/build/index.js generate
NODE_OPTIONS='--max-old-space-size=512' npm run build
node --test dist/security.test.js dist/cors_policy.test.js dist/s3.test.js
node dist/scripts/check-s3.js --write
pm2 restart petie-backend --update-env
curl --fail --silent http://127.0.0.1:5000/health