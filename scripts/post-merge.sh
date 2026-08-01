#!/bin/bash
set -e

# Install any dependencies added by merged tasks (fast no-op when unchanged)
npm install --no-audit --no-fund

# Apply idempotent DB migrations added by merged tasks (ordered by filename)
if [ -n "$DATABASE_URL" ]; then
  for f in scripts/db/*.sql; do
    [ -e "$f" ] || continue
    echo "Applying migration: $f"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
fi
