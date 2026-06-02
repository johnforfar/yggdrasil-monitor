#!/usr/bin/env bash
# Probes a fixed list of domains across 3 DNS resolvers + HTTPS.
# Appends one JSON line per probe to $DATA_DIR/probes.jsonl.
# Runs every 60s under a systemd timer.

set -u

DATA_DIR="${DATA_DIR:-/var/lib/yggdrasil-monitor}"
JSONL="$DATA_DIR/probes.jsonl"
mkdir -p "$DATA_DIR"

DOMAINS=(
  ai.buildooors.com
  network.buildooors.com
  dashboard.buildooors.com
  desktop.buildooors.com
  sledgit.com
  community.openxai.org
  openxai.org
  openmesh.network
  v10.build.openmesh.cloud
)

RESOLVERS=(1.1.1.1 8.8.8.8 9.9.9.9)

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
emit() { printf '%s\n' "$1" >> "$JSONL"; }

# --- DNS layer ---------------------------------------------------------------
for d in "${DOMAINS[@]}"; do
  for r in "${RESOLVERS[@]}"; do
    t0=$(date +%s%N)
    answer=$(dig +short +time=2 +tries=1 "@$r" "$d" A "$d" AAAA 2>/dev/null)
    rc=$?
    t1=$(date +%s%N)
    took_ms=$(( (t1 - t0) / 1000000 ))

    if [[ $rc -ne 0 ]]; then
      result="error"
    elif [[ -z "$answer" ]]; then
      result="empty"
    elif echo "$answer" | grep -qE "\.yggdrasil\.[a-z.]+\.?$"; then
      # CNAME chain ends at a yggdrasil-encoded subdomain that did not resolve to an IP.
      result="cname_only"
    else
      result="resolved"
    fi

    answer_first=$(echo "$answer" | head -1 | sed 's/"/\\"/g')
    emit "{\"ts\":\"$now\",\"layer\":\"dns\",\"domain\":\"$d\",\"resolver\":\"$r\",\"result\":\"$result\",\"took_ms\":$took_ms,\"answer\":\"$answer_first\"}"
  done

  # --- HTTPS layer ----------------------------------------------------------
  # 6 timing fields + ssl_verify_result (0 = trusted)
  vals=$(curl -s -o /dev/null -m 10 \
    -w "%{http_code}|%{time_namelookup}|%{time_connect}|%{time_starttransfer}|%{time_total}|%{ssl_verify_result}\n" \
    "https://$d" 2>/dev/null) || vals="0|0|0|0|0|99"

  IFS='|' read -r code tns tconn tstart ttotal sslv <<< "$vals"
  emit "{\"ts\":\"$now\",\"layer\":\"https\",\"domain\":\"$d\",\"http_code\":${code:-0},\"name_s\":${tns:-0},\"connect_s\":${tconn:-0},\"ttfb_s\":${tstart:-0},\"total_s\":${ttotal:-0},\"ssl_verify\":${sslv:-99}}"
done

# Optional retention: keep last 30 days only (≈ 30*24*60*(8*3+8) = ~1.4M lines = 500MB).
if [[ -f "$JSONL" ]]; then
  cutoff=$(date -u -d "30 days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v -30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
  if [[ -n "$cutoff" ]]; then
    tmp="$JSONL.tmp.$$"
    awk -v c="\"ts\":\"$cutoff\"" 'index($0, "\"ts\":\"") > 0 { p=substr($0, index($0, "\"ts\":\"")); if (p >= c) print }' "$JSONL" > "$tmp" 2>/dev/null
    if [[ -s "$tmp" ]]; then mv "$tmp" "$JSONL"; else rm -f "$tmp"; fi
  fi
fi
