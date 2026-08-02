# scripts/

One-off, manually-run SQL/shell scripts — not `supabase/migrations/`, so
nothing here applies automatically via `supabase db push`. Each script is
self-contained; run it by hand against the connection string you intend,
after reading it.

---

## Legacy Price Range Repair

**Status:** Completed

**Purpose:** Repair records corrupted by the legacy digit-stripping parser
that converted `"$280-300"` → `280300`. The old structured-pricing backfill
stripped every non-digit character from a legacy price string before
casting it to a number, so a genuine range with no digit separator left
over (`"$280-300"` → strip `-` → `"280300"`) silently became one bogus
large number, indistinguishable from a real high-value price once stored.

**Scripts:**
- [`diagnose-legacy-price-ranges.sql`](diagnose-legacy-price-ranges.sql) — read-only. Finds candidate rows and classifies them HIGH / MEDIUM confidence (or excludes them entirely when nothing looks wrong).
- [`generate-legacy-price-range-repairs.sql`](generate-legacy-price-range-repairs.sql) — read-only. Prints guarded, compare-and-swap `UPDATE` statements (plus a paired verification `SELECT`) for HIGH confidence rows only.

**Execution order:**
1. Run `diagnose-legacy-price-ranges.sql`.
2. Review the HIGH confidence rows.
3. Run `generate-legacy-price-range-repairs.sql` to generate guarded `UPDATE` statements.
4. Execute each statement manually, one at a time, inside its own transaction.
5. Verify each `UPDATE` with its paired `SELECT` before committing.
6. Re-run the diagnostic until no HIGH confidence rows remain.

**Never run generated `UPDATE` statements without reviewing them first.**

Full design rationale, confidence-tier definitions, and the idempotency/
concurrency-safety guarantees live in the header comments of the two
scripts themselves — read those before touching either file.
