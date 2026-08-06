# ops/ — DR backup keys and operator setup

The weekly DR backup (`.github/workflows/backup.yml`) **hard-fails at the
encryption step until `ops/backup.age.pub` exists** (that is deliberate —
fail closed, never upload an unencrypted dump). This directory holds ONLY
public keys. Private keys never enter the repo or the chat with anyone.

## One-time setup (operator, ~10 minutes)

### 1. Generate TWO age keypairs

```bash
age-keygen -o pintag-master.agekey     # DISASTER key — offline only
age-keygen -o pintag-drill.agekey      # DRILL key — lives only in GitHub secrets
```

Each file prints a `# public key: age1...` line.

- **Master private key** (`pintag-master.agekey`): print it / store it in a
  password manager + offline copy. It is used only in a real disaster, by a
  human, per `docs/BACKUP_AND_DISASTER_RECOVERY.md`. **Never** put it in CI.
- **Drill private key** (`pintag-drill.agekey` contents): add as the
  `BACKUP_AGE_DRILL_KEY` secret in the `production-backup` GitHub
  environment, then delete the local file. It exists so the quarterly
  restore drill (`.github/workflows/restore-drill.yml`) can decrypt and
  actually prove the backup restores — without ever exposing the master key.

### 2. Commit both PUBLIC keys here

Create `ops/backup.age.pub` containing both public keys, one per line
(age encrypts to every listed recipient):

```
age1...master-public-key...
age1...drill-public-key...
```

### 3. Set the backup secrets (GitHub → Settings → Environments → production-backup)

| Secret | Where it comes from |
|---|---|
| `SUPABASE_S3_ENDPOINT` / `SUPABASE_S3_ACCESS_KEY_ID` / `SUPABASE_S3_SECRET_ACCESS_KEY` | Supabase Dashboard → Storage → S3 connection |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare → R2 → create bucket + API token |
| `PINTAG_PROD_DB_URL` | Supabase Dashboard → Database → connection string (use the `backup_ro` role from `scripts/create-backup-ro-role.sql`) |
| `BACKUP_AGE_DRILL_KEY` | step 1 above |

Also set (repo-level, for monitoring):

| Secret / variable | Purpose |
|---|---|
| `ALERT_WEBHOOK_URL` (secret, optional) | where monitoring failures POST |
| `MIN_EXPECTED_LISTINGS` (variable) | listing-count floor for `monitoring.yml` |

### 4. Prove it

1. Actions → **Production DR Backup** → Run workflow → must go green.
2. Actions → **DR Restore Drill** → Run workflow → must go green.

Only after BOTH are green does Pintag have a backup — per the Never Again
rules, an unrestored backup is a hope, not a plan.
