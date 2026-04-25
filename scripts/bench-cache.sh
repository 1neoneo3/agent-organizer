#!/usr/bin/env bash
# Benchmark cache hit ratio and latency for GET /tasks
# Usage: ./scripts/bench-cache.sh [base_url] [iterations]
#
# Requires: curl, jq
# The server must be running with Redis connected.

set -euo pipefail

BASE_URL="${1:-http://localhost:8791/api}"
ITERATIONS="${2:-100}"

echo "=== Cache Benchmark ==="
echo "URL: ${BASE_URL}/tasks"
echo "Iterations: ${ITERATIONS}"
echo ""

# Reset stats
curl -sf "${BASE_URL}/health" > /dev/null 2>&1 || {
  echo "ERROR: Server not reachable at ${BASE_URL}/health"
  exit 1
}

echo "--- Before ---"
curl -sf "${BASE_URL}/health" | jq '.cacheStats'
echo ""

latencies=()
for i in $(seq 1 "$ITERATIONS"); do
  start=$(date +%s%N)
  curl -sf "${BASE_URL}/tasks" > /dev/null
  end=$(date +%s%N)
  elapsed_ms=$(( (end - start) / 1000000 ))
  latencies+=("$elapsed_ms")
done

echo "--- After ${ITERATIONS} requests ---"
curl -sf "${BASE_URL}/health" | jq '.cacheStats'
echo ""

# Sort latencies and compute p50/p95
IFS=$'\n' sorted=($(sort -n <<<"${latencies[*]}")); unset IFS
count=${#sorted[@]}
p50_idx=$(( count * 50 / 100 ))
p95_idx=$(( count * 95 / 100 ))
total=0
for v in "${sorted[@]}"; do total=$((total + v)); done
avg=$((total / count))

echo "--- Latency (ms) ---"
echo "  avg: ${avg}"
echo "  p50: ${sorted[$p50_idx]}"
echo "  p95: ${sorted[$p95_idx]}"
echo "  min: ${sorted[0]}"
echo "  max: ${sorted[$((count - 1))]}"
