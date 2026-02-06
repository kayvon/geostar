#!/bin/bash
set -e

YEAR="${1:?Usage: ./backfill.sh <year> (e.g. ./backfill.sh 2025)}"
BASE_URL="https://geostar-data-injest.kayvonghashghai.workers.dev/backfill"

for month in $(seq 1 12); do
  start=$(printf "%s-%02d-01" "$YEAR" "$month")
  if [ "$month" -eq 12 ]; then
    end="$((YEAR + 1))-01-01"
  else
    end=$(printf "%s-%02d-01" "$YEAR" "$((month + 1))")
  fi

  echo "Backfilling $start -> $end ..."
  response=$(curl -sf "$BASE_URL?start=$start&end=$end")
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
  echo ""
done

echo "Done!"
