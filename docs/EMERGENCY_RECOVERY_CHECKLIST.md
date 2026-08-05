# 🚨 Pintag Emergency Recovery — One-Page Checklist

**Use this during a disaster. Full detail: `docs/BACKUP_AND_DISASTER_RECOVERY.md`.**
You need: the **age private key** (offline), **R2 read credentials**, and a
**target Supabase project**. Restores are free to pull from R2 (zero egress).

---

### 0. Don't make it worse
- [ ] **Enable maintenance mode** (Cloudflare worker `MAINTENANCE_MODE = true`) so nothing writes to a half-restored site.
- [ ] Identify the backup to restore: `R2:<bucket>/backup-YYYY-MM-DD/` (latest verified). Read its `metadata/backup.json`.

### 1. Get the backup
- [ ] `rclone copy R2:<bucket>/backup-YYYY-MM-DD ./restore --transfers 8`
- [ ] `rclone copy R2:<bucket>/storage/objects ./restore/objects --transfers 8` (photo pool)

### 2. Decrypt PII artifacts
- [ ] `age -d -i backup-age-key.txt -o restore/database/full.dump restore/database/full.dump.age`
- [ ] Decrypt `restore/database/relationships/*.age` the same way (if doing a CSV-level restore).

### 3. Restore the database
- [ ] Target ready (project created; if empty, apply `database/schema.sql` first).
- [ ] `PINTAG_RESTORE_DB_URL="postgresql://…target…" ./scripts/restore-production.sh --backup ./restore`
- [ ] Confirm the printed report shows **✓ Database / ✓ Relationships / ✓ Security**.

### 4. Restore the photos
- [ ] Recreate bucket `property-images` (public-read, admin-write) if missing.
- [ ] Re-upload the pool (names preserved ⇒ `properties.images` URLs resolve):
      `rclone copy ./restore/objects "SB:property-images" --transfers 8`
- [ ] Spot-check: open a listing's `og:image` URL — the photo loads.

### 5. Verify everything
- [ ] Re-run: `psql "$PINTAG_RESTORE_DB_URL" -f scripts/restore-validation.sql`
- [ ] Counts match `metadata/backup.json`; `rls_policies_present` and `functions_present` > 0.
- [ ] `migration_head` matches `database/migrations.csv`.

### 6. Re-provision access & reopen
- [ ] Re-provision the admin per **single-admin runbook** (`FIRST_ADMIN_ONBOARDING.md`) — auth users are **not** restored from the dump (reference only).
- [ ] Point config (`config.prod.js`) / the worker at the restored project if it changed.
- [ ] Smoke test: app boots, a listing renders, admin login + MFA works.
- [ ] **Disable maintenance mode.**

---

**Restore is complete only when the report reads:**
`✓ Database  ✓ Storage  ✓ Relationships  ✓ Security  ✓ Ready for production`

*If any step fails, STOP — do not reopen. Escalate with the failing check and the backup date.*
