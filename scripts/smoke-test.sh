#!/usr/bin/env bash
# Pre-publish smoke test for Toolstem SEC MCP Server.
# Calls every tool against the LIVE Apify Actor and fails loudly on any error,
# empty response, missing-data regression, or missing meta.source field.
#
# Usage:
#   APIFY_TOKEN=xxx ./scripts/smoke-test.sh
#   APIFY_TOKEN=xxx ACTOR=toolstem~toolstem-sec-mcp-server-staging ./scripts/smoke-test.sh
#
# Exit code 0 = all tools healthy, safe to publish.
# Exit code !=0 = DO NOT publish. Investigate before shipping to npm / MCP Registry.

set -euo pipefail

: "${APIFY_TOKEN:?APIFY_TOKEN env var is required}"
ACTOR="${ACTOR:-toolstem~toolstem-sec-mcp-server}"
TIMEOUT="${TIMEOUT:-120}"

# Pass the Apify token via Authorization header, never in the URL query
# string. URL-embedded tokens can leak into curl verbose output, error
# messages, and third-party log aggregators (especially in CI).
APIFY_AUTH_HEADER="Authorization: Bearer ${APIFY_TOKEN}"
DATA_URL="https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${TIMEOUT}"
RUN_URL="https://api.apify.com/v2/acts/${ACTOR}/runs?waitForFinish=${TIMEOUT}"

PASS=0
FAIL=0
WARN=0
FAILURES=()
# Most recent HTTP status code from call_tool, persisted to a tmp file so it
# survives across command-substitution subshells. A previous in-memory variable
# was reset to empty every call because `RESP=$(call_tool ...)` runs call_tool
# inside a subshell whose variable assignments do not propagate to the parent.
HTTP_CODE_FILE="$(mktemp -t smoke_http_code.XXXXXX)"
trap 'rm -f "$HTTP_CODE_FILE"' EXIT

call_tool() {
  local name="$1"
  local payload="$2"
  local body_file
  body_file="$(mktemp -t smoke_resp.XXXXXX)"
  local http_code
  # `-w "%{http_code}"` prints the HTTP status to stdout while the body is
  # written to a temp file. `-sS` keeps curl quiet but still surfaces network
  # errors. We deliberately do NOT use `--fail` because we want to inspect 4xx
  # response bodies (e.g. Apify error envelopes) rather than have curl swallow
  # them.
  http_code=$(curl -sS -o "$body_file" -w "%{http_code}" -X POST "$DATA_URL" \
    -H "$APIFY_AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo "000")
  # Persist to file (NOT a shell variable) so the parent shell can read it
  # after the command-substitution subshell exits.
  printf '%s' "$http_code" > "$HTTP_CODE_FILE"
  if [ -f "$body_file" ]; then
    cat "$body_file"
    rm -f "$body_file"
  fi
}

assert_http_2xx() {
  local label="$1"
  local code=""
  if [ -f "$HTTP_CODE_FILE" ]; then
    code="$(cat "$HTTP_CODE_FILE")"
  fi
  if [ -n "$code" ] && [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ] 2>/dev/null; then
    check "HTTP 2xx [$label]" 1
  else
    check "HTTP 2xx [$label]" 0 "got HTTP $code"
  fi
}

run_and_get_run_json() {
  local payload="$1"
  local run_response
  run_response=$(curl -sS -X POST "$RUN_URL" \
    -H "$APIFY_AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$payload")
  echo "$run_response"
}

check() {
  local label="$1"
  local condition="$2"
  local detail="${3:-}"
  if [ "$condition" = "1" ]; then
    printf "  \033[32mPASS\033[0m  %s\n" "$label"
    PASS=$((PASS+1))
  else
    printf "  \033[31mFAIL\033[0m  %s  %s\n" "$label" "$detail"
    FAIL=$((FAIL+1))
    FAILURES+=("$label: $detail")
  fi
}

warn() {
  local label="$1"
  local detail="$2"
  printf "  \033[33mWARN\033[0m  %s  %s\n" "$label" "$detail"
  WARN=$((WARN+1))
}

echo "=========================================="
echo "Toolstem SEC MCP Server smoke test"
echo "Actor: $ACTOR"
echo "Time:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=========================================="

# ---------------------------------------------------------------------------
# Test 1: get_company_filings_summary (AAPL)
# ---------------------------------------------------------------------------
echo ""
echo "[1/8] get_company_filings_summary (AAPL) – functional"
RESP=$(call_tool "get_company_filings_summary" '{"tool":"get_company_filings_summary","ticker_or_cik":"AAPL"}')
assert_http_2xx "filings_summary"

ERR=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')) if isinstance(d,dict) else print('')" 2>/dev/null || echo "parse-error")
if [ -n "$ERR" ] && [ "$ERR" != "parse-error" ]; then
  check "no actor error [filings_summary]" 0 "$ERR"
else
  CIK=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('cik',''))" 2>/dev/null || echo "")
  SOURCE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('meta',{}).get('source',''))" 2>/dev/null || echo "")
  FILINGS=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
item=d[0] if isinstance(d,list) and d else {}
filings=item.get('recent_filings',[])
print(len(filings) if isinstance(filings,list) else 0)
" 2>/dev/null || echo "0")

  [ -n "$CIK" ] && check "cik is set [filings_summary]" 1 || check "cik is set [filings_summary]" 0 "got '$CIK'"
  [ "$SOURCE" = "sec_edgar_direct" ] && check "meta.source=sec_edgar_direct [filings_summary]" 1 || check "meta.source=sec_edgar_direct [filings_summary]" 0 "got '$SOURCE'"
  [ "$FILINGS" -gt 0 ] 2>/dev/null && check "recent_filings non-empty [filings_summary]" 1 || check "recent_filings non-empty [filings_summary]" 0 "got $FILINGS"
fi

echo ""
echo "[2/8] get_company_filings_summary – billing"
run_and_get_run_json '{"tool":"get_company_filings_summary","ticker_or_cik":"AAPL"}' > /dev/null 2>&1 || true
warn "filings_summary billing" "skipped: owner runs are not charged by Apify"

# ---------------------------------------------------------------------------
# Test 2: get_insider_signal (MSFT, lookback_days=90)
# ---------------------------------------------------------------------------
echo ""
echo "[3/8] get_insider_signal (MSFT, lookback_days=90) – functional"
RESP=$(call_tool "get_insider_signal" '{"tool":"get_insider_signal","ticker_or_cik":"MSFT","lookback_days":90}')
assert_http_2xx "insider_signal"

ERR=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')) if isinstance(d,dict) else print('')" 2>/dev/null || echo "parse-error")
if [ -n "$ERR" ] && [ "$ERR" != "parse-error" ]; then
  check "no actor error [insider_signal]" 0 "$ERR"
else
  CIK=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('cik',''))" 2>/dev/null || echo "")
  SOURCE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('meta',{}).get('source',''))" 2>/dev/null || echo "")
  LBDAYS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('lookback_days',''))" 2>/dev/null || echo "")

  [ -n "$CIK" ] && check "cik is set [insider_signal]" 1 || check "cik is set [insider_signal]" 0 "got '$CIK'"
  [ "$SOURCE" = "sec_edgar_direct" ] && check "meta.source=sec_edgar_direct [insider_signal]" 1 || check "meta.source=sec_edgar_direct [insider_signal]" 0 "got '$SOURCE'"
  [ "$LBDAYS" = "90" ] && check "lookback_days=90 [insider_signal]" 1 || check "lookback_days=90 [insider_signal]" 0 "got '$LBDAYS'"
fi

# ---------------------------------------------------------------------------
# Test 3: get_institutional_signal (NVDA, quarters_back=4)
# ---------------------------------------------------------------------------
echo ""
echo "[4/8] get_institutional_signal (NVDA, quarters_back=4) – functional"
RESP=$(call_tool "get_institutional_signal" '{"tool":"get_institutional_signal","ticker_or_cik":"NVDA","quarters_back":4}')
assert_http_2xx "institutional_signal"

ERR=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')) if isinstance(d,dict) else print('')" 2>/dev/null || echo "parse-error")
if [ -n "$ERR" ] && [ "$ERR" != "parse-error" ]; then
  check "no actor error [institutional_signal]" 0 "$ERR"
else
  CIK=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('cik',''))" 2>/dev/null || echo "")
  SOURCE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('meta',{}).get('source',''))" 2>/dev/null || echo "")
  FLAG=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); v=(d[0] if isinstance(d,list) and d else {}).get('activist_risk_flag'); print('' if v is None else str(v))" 2>/dev/null || echo "")

  [ -n "$CIK" ] && check "cik is set [institutional_signal]" 1 || check "cik is set [institutional_signal]" 0 "got '$CIK'"
  [ "$SOURCE" = "sec_edgar_direct" ] && check "meta.source=sec_edgar_direct [institutional_signal]" 1 || check "meta.source=sec_edgar_direct [institutional_signal]" 0 "got '$SOURCE'"
  [ -n "$FLAG" ] && check "activist_risk_flag present [institutional_signal]" 1 || check "activist_risk_flag present [institutional_signal]" 0 "got '$FLAG'"
fi

# ---------------------------------------------------------------------------
# Test 4: get_material_events_digest (TSLA, lookback_days=180) — premium
# ---------------------------------------------------------------------------
echo ""
echo "[5/8] get_material_events_digest (TSLA, lookback_days=180) – functional (premium)"
RESP=$(call_tool "get_material_events_digest" '{"tool":"get_material_events_digest","ticker_or_cik":"TSLA","lookback_days":180}')
assert_http_2xx "material_events"

ERR=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')) if isinstance(d,dict) else print('')" 2>/dev/null || echo "parse-error")
if [ -n "$ERR" ] && [ "$ERR" != "parse-error" ]; then
  check "no actor error [material_events]" 0 "$ERR"
else
  CIK=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('cik',''))" 2>/dev/null || echo "")
  SOURCE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('meta',{}).get('source',''))" 2>/dev/null || echo "")
  EVENTS_COUNT=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
item=d[0] if isinstance(d,list) and d else {}
events=item.get('events')
print(len(events) if isinstance(events,list) else -1)
" 2>/dev/null || echo "-1")

  [ -n "$CIK" ] && check "cik is set [material_events]" 1 || check "cik is set [material_events]" 0 "got '$CIK'"
  [ "$SOURCE" = "sec_edgar_direct" ] && check "meta.source=sec_edgar_direct [material_events]" 1 || check "meta.source=sec_edgar_direct [material_events]" 0 "got '$SOURCE'"
  # Spec requires a non-empty events array. Empty array indicates a filtering bug,
  # lookback off-by-one, or EDGAR index key change — would silently ship a broken
  # premium tool if we only checked for type 'list'.
  [ "$EVENTS_COUNT" -gt 0 ] 2>/dev/null && check "events non-empty [material_events]" 1 || check "events non-empty [material_events]" 0 "got $EVENTS_COUNT events"
fi

echo ""
echo "[6/8] get_material_events_digest – billing (premium)"
run_and_get_run_json '{"tool":"get_material_events_digest","ticker_or_cik":"TSLA","lookback_days":180}' > /dev/null 2>&1 || true
warn "material_events billing" "skipped: owner runs are not charged by Apify"

# ---------------------------------------------------------------------------
# Test 5: compare_disclosure_signals (AAPL, MSFT, GOOGL)
# ---------------------------------------------------------------------------
echo ""
echo "[7/8] compare_disclosure_signals ([AAPL, MSFT, GOOGL]) – functional"
RESP=$(call_tool "compare_disclosure_signals" '{"tool":"compare_disclosure_signals","tickers_or_ciks":["AAPL","MSFT","GOOGL"]}')
assert_http_2xx "compare"

ERR=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')) if isinstance(d,dict) else print('')" 2>/dev/null || echo "parse-error")
if [ -n "$ERR" ] && [ "$ERR" != "parse-error" ]; then
  check "no actor error [compare]" 0 "$ERR"
else
  N=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
item=d[0] if isinstance(d,list) and d else {}
companies=item.get('companies',[])
print(len(companies) if isinstance(companies,list) else 0)
" 2>/dev/null || echo "0")
  SOURCE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('meta',{}).get('source',''))" 2>/dev/null || echo "")
  WINNERS=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
item=d[0] if isinstance(d,list) and d else {}
print('dict' if isinstance(item.get('winners'),dict) else 'missing')
" 2>/dev/null || echo "missing")

  [ "$N" = "3" ] && check "3 companies returned [compare]" 1 || check "3 companies returned [compare]" 0 "got $N"
  [ "$SOURCE" = "sec_edgar_direct" ] && check "meta.source=sec_edgar_direct [compare]" 1 || check "meta.source=sec_edgar_direct [compare]" 0 "got '$SOURCE'"
  [ "$WINNERS" = "dict" ] && check "winners object present [compare]" 1 || check "winners object present [compare]" 0 "got '$WINNERS'"
fi

# ---------------------------------------------------------------------------
# Test 6: empty input should run default demonstration
# ---------------------------------------------------------------------------
echo ""
echo "[8/8] empty input — should run default demonstration (get_company_filings_summary AAPL)"
RESP=$(call_tool "empty_input_default_demo" '{}')
assert_http_2xx "default_demo"
DEMO_CIK=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) and d else {}).get('cik',''))" 2>/dev/null || echo "")
[ -n "$DEMO_CIK" ] && check "empty input → default demo returns a CIK" 1 || check "empty input → default demo returns a CIK" 0 "got '$DEMO_CIK'"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=========================================="
echo "PASS: $PASS   WARN: $WARN   FAIL: $FAIL"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "DO NOT PUBLISH. Failures:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi

echo ""
echo "All tools healthy. Safe to publish."
exit 0
