# L1 Verification Pack — run order and exact commands

*Companion to `scripts/verify-l1-baseline.sql` and
`docs/L1_PRODUCTION_SAFE_CERTIFICATION.md`. Everything here runs on the
operator's side (production is not reachable from the development sandbox).
Record every output in the certification doc as you go — the certification
stays PENDING until its evidence column is full.*

**Run order:** 0 (operator steps) → 1 (MFA) → SQL Parts A–C → 4 (backup/drill)
→ 5 (monitoring delivery).

---

## 0. Operator steps (prerequisites)

1. SQL editor → apply, in order: `20260806010000_enforce_aal2_admin.sql`,
   `20260806020000_soft_delete_and_snapshots.sql`,
   `20260806030000_mass_delete_alerting.sql`.
2. Redeploy edge functions: `generate-listing-content`,
   `smart-listing-importer`, `facebook-listing-fetcher`,
   `generate-intelligence-report`, `resolve-map-url`
   (`supabase functions deploy <name>` ×5, or via Dashboard).
3. `ops/README.md` setup: two age keys, `ops/backup.age.pub` committed,
   8 secrets in the `production-backup` environment, `BACKUP_AGE_DRILL_KEY`,
   optional `ALERT_WEBHOOK_URL`, repo variable `MIN_EXPECTED_LISTINGS`.
4. Dashboard → Database → Backups → enable **PITR**.
5. Recommended while verifying: set a real webhook in the DB:
   `UPDATE ops_alert_config SET webhook_url='<your channel webhook>' WHERE id=1;`

---

## 1. MFA verification (the one nothing may bypass)

### 1a. Get a deliberately-weak AAL1 token (password only — do NOT enter a TOTP code)

```bash
SB=https://eoladhcljbpbhnrmmpev.supabase.co
ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0'
read -rs PW    # type the admin password, invisible, not stored in history
TOK=$(curl -s "$SB/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"cyrora.trading@gmail.com\",\"password\":\"$PW\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
unset PW
# Confirm the token really is aal1 (prints: aal1):
python3 - "$TOK" <<'PY'
import base64, json, sys
p = sys.argv[1].split('.')[1]
print(json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))['aal'])
PY
```

### 1b. Every privileged path must REFUSE this token

```bash
# RLS write → expect []  (empty array = zero rows updated)
curl -s -X PATCH "$SB/rest/v1/properties?title_en=eq.L1-VERIFY-SOFT-DELETE-TEST" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"village":"aal1-should-not-write"}'

# RPC authorization primitive → expect false
curl -s -X POST "$SB/rest/v1/rpc/is_pintag_admin" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -d "{\"p_uid\":\"$(python3 - "$TOK" <<'PY'
import base64, json, sys
p = sys.argv[1].split('.')[1]
print(json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))['sub'])
PY
)\"}"

# Admin-gated RPC → expect an "admin only" error
curl -s -X POST "$SB/rest/v1/rpc/listing_timeline" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -d '{"p_listing":"00000000-0000-0000-0000-000000000000"}'

# Edge function → expect HTTP 403 {"error":"MFA required"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SB/functions/v1/generate-listing-content" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -d '{}'

# Storage write → expect an RLS/policy violation error
curl -s -X POST "$SB/storage/v1/object/property-images/l1-verify-aal1.jpg" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: image/jpeg" --data-binary 'x'
```

All five refused = **MFA negative test PASS**. Any success = FAIL — stop and
investigate before continuing.

### 1c. The same paths must SUCCEED at AAL2

Log in to `admin.html` normally (password **+ TOTP**), then, as the positive
test: edit any listing field and save (RLS write), run one AI title
generation (edge function), upload one photo (storage). All three working
= **MFA positive test PASS**. This also proves the security regression the
other way — the lockout applies to missing MFA, not to you.

*Note the security-event log check for §5: the refused edge-function call
from 1b must appear in Dashboard → Edge Functions → generate-listing-content
→ Logs as a `{"security_event":"aal2_required",...}` line.*

---

## 2–3. Soft delete, snapshots, hard-delete protection

Run `scripts/verify-l1-baseline.sql` **Parts A → B → C** in the SQL editor,
following its inline instructions (Part B includes one step performed through
the admin UI — that's deliberate: the application path is what's being
certified). Expected: A = 8×PASS, B = 3×PASS + restore row + 2×PASS,
C = **an ERROR on the bulk delete (the error is the pass)** + 10 survivors +
clean alert trail.

---

## 4. Backup + restore drill

1. Actions → **Production DR Backup** → *Run workflow* → must end green
   (its verify steps are fail-closed: storage hashes vs manifest,
   `pg_restore --list`, row-count deltas).
2. Actions → **DR Restore Drill** → *Run workflow* → must end green; open the
   run summary and confirm the restore report shows ✓ per table with counts
   matching the backup metadata, and note the drill duration printed at the
   end (RTO evidence).
3. Storage restore correctness is certified by the backup's own
   `rclone check --checksum` (byte-identical objects in R2); to make it
   tangible, download one object from R2 and one from the live bucket and
   compare SHA-256 — record the matching hashes.

---

## 5. Monitoring — verify DELIVERY, not existence

| Event | How to trigger safely | Delivery to verify |
|---|---|---|
| Security event | The 1b edge-function refusal | JSON `security_event` line visible in the function's logs |
| Delete alert | Part B-6 / C-5 single hard deletes | Message **arrives in the webhook channel** (Telegram/Slack/Discord) within seconds — if `webhook_url` is set. `ops_alerts` rows alone don't count as delivery |
| Monitoring alert | Set repo variable `MIN_EXPECTED_LISTINGS=99999` → Actions → **Production Monitoring** → run → it must FAIL → **check your email inbox** for the GitHub Actions failure notification (and the webhook POST if `ALERT_WEBHOOK_URL` is set) → reset the variable → run again → green | The failure email/webhook actually received |
| Backup alert | Same channel as above: any backup.yml failure produces the identical GitHub failure email — the channel is proven by the monitoring test; no need to force a backup failure | (channel shared with monitoring) |

---

## 6. Close out

Fill every evidence field in `docs/L1_PRODUCTION_SAFE_CERTIFICATION.md`,
flip its status to CERTIFIED, commit. From then on the standing rule applies:
**Implemented ≠ Complete** — a feature is complete only when it is
implemented, verified, documented, monitored, and recoverable.
