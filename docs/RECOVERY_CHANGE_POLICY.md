# Recovery Change Policy — how recovery batches reach production

*Adopted 2026-08-06 as part of the L1 Production Safe baseline. This codifies
the exact discipline that made the 2026-08 recovery fills trustworthy (dry-run
report → approval → rollback-snapshotted transaction → count-verified commit)
as the PERMANENT rule for every future recovery or bulk-repair write.*

## The rule

**Recovery scripts never execute on production first.** Production only ever
receives a validated batch that has already been proven elsewhere (dev
project, scratch restore, or — at minimum — a read-only dry run of the exact
statements against production data).

Every recovery batch MUST support all five stages, in order:

| Stage | What it means | Concretely |
|---|---|---|
| **1. Dry Run** | Read-only. Produces the full list of intended changes without writing anything. | A `SELECT` emitting one row per intended change: id, field, current value, proposed value, evidence source, confidence. |
| **2. Preview** | A human reads the dry-run output — every row, not a sample summary. | Exported via `\copy` / one-cell `string_agg` (the SQL-editor 100-row cap truncates; never approve a truncated preview). |
| **3. Diff** | The expected effect is stated as verifiable numbers BEFORE the write. | "This will update exactly N fields on M listings" — written down where the operator approves it. |
| **4. Commit** | One transaction; fill-only-when-empty; rollback snapshot written first; count-checked. | `BEGIN` → snapshot previous values into the rollback table (`recovery_fill_rollback` pattern) → `UPDATE ... WHERE <field> IS NULL/''` → compare affected counts to the Stage-3 numbers → **automatic `ROLLBACK` on any mismatch** → `COMMIT`. |
| **5. Rollback** | A ready, tested statement that restores the previous values from the snapshot. | Written and included WITH the batch, not improvised after. Idempotent, so it is safe to run twice. |

## Standing constraints (unchanged from the recovery project)

- **Fill-only-when-empty.** A recovery write never overwrites a non-empty
  value. Conflicts are surfaced to the operator, never auto-resolved.
- **Idempotent.** Running a batch twice must change nothing the second time.
- **Attributed.** Every batch records evidence source and operator; AI-derived
  values carry their distinct provenance source (e.g. `recovery_ai_generated`).
- **Documented.** Every batch gets an entry in the Evidence Register
  (`docs/RECOVERY_EVIDENCE_REGISTER.md`): what ran, when, counts, rollback
  location. "Every recovery must be documented" — Never Again rule #9.

## Why this is permanent

The 2026-08 recovery worked *because* of this shape: the 88-field metadata
fill was previewed in full, snapshotted into `recovery_fill_rollback`,
executed in one transaction, and verified by count before commit. Nothing
about that was overhead — it was the reason the writes could be trusted.
This policy makes that the default for every future batch, not an heirloom
of one incident.
