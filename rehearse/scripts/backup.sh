#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U interview -d interview | gzip > "backups/interview-$stamp.sql.gz"
cp .env "backups/environment-$stamp.env"
printf 'Saved database and encryption-key backup in backups/ (%s). Keep both private.\n' "$stamp"
