#!/usr/bin/env bash
# Suite 11 — Secret Leakage Scanning
#
# @suite    Secret Scan
# @purpose  Scan tracked repository files for accidentally committed secrets and credentials
# @covers   static
# @needs    none
# @runtime  ~5s
#
# Scans tracked repository files for accidentally committed secrets:
#   - Service-role JWTs (Supabase role=service_role)
#   - PEM private keys (BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY)
#   - Committed .env files (not .env.example / .env.sample)
#   - OpenAI API key pattern (sk-...)
#   - Google API key pattern (AIza...)
#
# The anon key (role=anon) is intentionally public and is excluded.
# The tests/ directory is excluded so the suite can reference secret patterns
# without triggering itself.
#
# Requires: git (to enumerate tracked files), python3 (to decode JWTs).

run_secret_scan_tests() {
  suite_start "Secret Scan"

  # Work from git-tracked files so we catch committed but not-yet-pushed files
  # and ignore untracked / gitignored paths.
  if ! command -v git &>/dev/null; then
    skip "All secret scan tests" "git not found"
    suite_end
    return
  fi

  # Build the file list once: tracked files, excluding the test suite itself
  # and binary/generated paths that produce false positives.
  local file_list
  file_list=$(git ls-files 2>/dev/null | grep -v \
    -e '^tests/security/' \
    -e '\.min\.js$' \
    -e '^node_modules/' \
    -e '^dist/' \
    -e '^build/' \
    -e '^\.git/')

  if [[ -z "$file_list" ]]; then
    skip "Secret scan" "no tracked files found (not a git repo?)"
    suite_end
    return
  fi

  # ════════════════════════════════════
  # 1. Committed .env files
  # .env.example / .env.sample / .env.template are intentional — skip them.
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no committed .env files"
  local committed_envs
  committed_envs=$(echo "$file_list" | grep -E '(^|/)\.env$|(^|/)\.env\.(local|dev|staging|production|test)$' || true)
  if [[ -n "$committed_envs" ]]; then
    fail_hard "Committed .env file found" "$committed_envs"
  else
    check "no committed .env files" "." "ok"
  fi

  # ════════════════════════════════════
  # 2. PEM private keys
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no PEM private keys"
  local pem_files
  pem_files=$(echo "$file_list" | xargs grep -l \
    -e '-----BEGIN PRIVATE KEY-----' \
    -e '-----BEGIN RSA PRIVATE KEY-----' \
    -e '-----BEGIN EC PRIVATE KEY-----' \
    --binary-files=without-match 2>/dev/null || true)
  if [[ -n "$pem_files" ]]; then
    fail_hard "PEM private key found in repository" "$pem_files"
  else
    check "no PEM private keys committed" "." "ok"
  fi

  # ════════════════════════════════════
  # 3. Service-role JWTs
  # Decode every JWT-like string found in the repo; fail if any have role=service_role.
  # The known anon key (role=anon) is ignored.
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no service-role JWTs"
  if command -v python3 &>/dev/null; then
    local srk_result
    srk_result=$(echo "$file_list" | xargs grep -hE \
      'eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}' \
      --binary-files=without-match 2>/dev/null \
      | grep -oE 'eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+' \
      | sort -u \
      | python3 -c "
import sys, base64, json

found = []
for jwt in sys.stdin.read().splitlines():
    try:
        parts = jwt.split('.')
        if len(parts) != 3:
            continue
        pad = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(pad))
        if payload.get('role') == 'service_role':
            found.append(jwt[:40] + '...')
    except Exception:
        pass
if found:
    print('FOUND:' + '|'.join(found))
" 2>/dev/null || true)

    if echo "$srk_result" | grep -q '^FOUND:'; then
      fail_hard "Service-role JWT found in repository" \
        "Tokens: ${srk_result#FOUND:}"
    else
      check "no service-role JWTs committed" "." "ok"
    fi
  else
    skip "Service-role JWT scan" "python3 not found"
  fi

  # ════════════════════════════════════
  # 4. OpenAI API key pattern (sk-[a-zA-Z0-9]{20,})
  # These look like: sk-abc123... or sk-proj-...
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no OpenAI API keys"
  local oai_files
  oai_files=$(echo "$file_list" | xargs grep -lE \
    'sk-[a-zA-Z0-9]{20,}' \
    --binary-files=without-match 2>/dev/null \
    | grep -v '\.md$' | grep -v 'package-lock\.json' || true)
  if [[ -n "$oai_files" ]]; then
    fail_hard "Possible OpenAI API key found" "$oai_files"
  else
    check "no OpenAI API key patterns committed" "." "ok"
  fi

  # ════════════════════════════════════
  # 5. Google API key pattern (AIza[0-9A-Za-z-_]{35})
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no Google API keys"
  local gcp_files
  gcp_files=$(echo "$file_list" | xargs grep -lE \
    'AIza[0-9A-Za-z_-]{35}' \
    --binary-files=without-match 2>/dev/null \
    | grep -v '\.md$' || true)
  if [[ -n "$gcp_files" ]]; then
    fail_hard "Possible Google API key found" "$gcp_files"
  else
    check "no Google API key patterns committed" "." "ok"
  fi

  # ════════════════════════════════════
  # 6. DATABASE_URL / POSTGRES_PASSWORD with actual values
  # Pattern: VAR=value where value is not a shell variable reference or placeholder
  # ════════════════════════════════════
  CURRENT_TEST="secret scan: no DB credentials in source"
  local db_files
  db_files=$(echo "$file_list" | xargs grep -lE \
    '(DATABASE_URL|POSTGRES_PASSWORD)\s*=\s*[^$\{\(\<\"]' \
    --binary-files=without-match 2>/dev/null \
    | grep -v '\.md$' | grep -v '\.example$' | grep -v '\.sample$' | grep -v '\.template$' || true)
  if [[ -n "$db_files" ]]; then
    fail_hard "Possible DB credential hardcoded in source" "$db_files"
  else
    check "no DB credentials in source files" "." "ok"
  fi

  suite_end
}
