# Session Summary — 2026-07-04

Branch: `claude/pintag-marketing-ai-arch-rfq4a7`. Goal: connect the Marketing OS Dev Supabase project for real and continue M1 verification against it (previously M1 was only verified against a local, ephemeral Supabase stack — see `SETUP.md`).

## Completed today

1. **Connected to the Marketing OS Dev Supabase project.**
   - Verified `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` present in `.env.local` (gitignored, never printed).
   - Direct Postgres connection failed (no IPv6 route from this environment); switched to the project's Transaction Pooler connection string, which worked.

2. **Applied all pending migrations** via `supabase db push`: `0001_init_control_plane.sql`, `0002_agent_health.sql`, `0003_publish_simulation.sql`. All idempotent (`if not exists` guards) — safe to re-run.

3. **Verified schema**: confirmed all 10 expected tables exist in `public` — `content_items`, `content_calendar`, `quality_scores`, `approvals_queue`, `performance_metrics`, `campaigns`, `trend_signals`, `competitor_notes`, `org_settings`, `agent_health`. Row counts confirmed the project was otherwise empty except migration seed rows (`org_settings` default row, `agent_health` per-employee rows).

4. **Ran the real pipeline against this cloud project** (`npm run pipeline`, `LLM_PROVIDER=claude-cli`, `META_PUBLISH_MODE=simulate` default): Plan → Research → Write → Guardian → Schedule → Publish-decision, end to end.
   - First attempt was killed by a tool timeout mid-Write; the orphaned `content_items` row and its `generated-content/` directory (topic: "What to check before making an offer...") were cleaned up (deleted) since nothing downstream was built on it. This was debris from the killed attempt, not real work.
   - Second attempt completed cleanly: produced one educational post, "Same house, two listings: why Vientiane properties are often for sale AND for rent," Guardian pass 1 verdict `pass` (composite 0.884), scheduled for Facebook, landed in `approvals_queue` awaiting founder decision (Phase 1 — every item requires manual approval).

5. **Found and fixed a real bug in Guardian's verdict logic** (`pipeline/stages/06-guardian-review.ts`): Guardian's pass-1 notes flagged a required fix (draft's CTA was in the "browse listings" family, but `posting-rules.md`'s CTA Consistency rule requires the "Learn more / explore related guide" family for educational posts) while still returning verdict `pass`. Root cause: the deterministic verdict check (`meetsThreshold`) only looks at the 8 continuous 0.0–1.0 dimensions; hard pass/fail rules from `posting-rules.md` (CTA family, banned language, disclosure) had no structural representation, so a real violation could be described in prose and still pass numerically.
   - Fix: added a `policyCompliant` boolean to Guardian's structured output, independent of the 8 dimensions, that the model must set based on hard `posting-rules.md` compliance. Verdict now requires `meetsThreshold(...) && policyCompliant`. Fails closed — a missing/non-boolean value is treated as non-compliant, not defaulted to true. No DB schema change; a false result also prefixes the stored `revision_notes` with `[POSTING RULES VIOLATION]` for auditability.
   - Typecheck passes; no other files referenced the old `GuardianOutput` shape.

6. **Revised the draft and re-verified**: used the pipeline's own `revise()` (Writer stage) against Guardian's pass-1 notes, then re-ran `guardianReview()` (pass 2) with the fixed logic.
   - Pass 2 verdict: `pass`, composite 0.893. CTA now reads "Read our guide on negotiating a dual-listed property on Pintag..." — correct family. Guardian's pass-2 notes explicitly confirm: "CTA correctly uses the educational-post 'explore related guide' family, matching the Learn More CTA rule." No more mismatch between verdict and notes.
   - Confirmed `approvals_queue` (`decision: null`) and `content_calendar` (`awaiting_approval`) were untouched by the revision/re-review — nothing was auto-approved.

## Known items not fixed (flagged, not in scope today)

- `content_items.status` reads `approved` rather than `scheduled`, because `guardianReview()`'s status write doesn't know the item was already scheduled downstream — it unconditionally sets `approved`/`revising` on every review pass, overwriting `scheduled` back to `approved` after the pass-2 re-review. Cosmetic only: `content_calendar` and `approvals_queue` are still correct and consistent. Worth a small fix later if it causes confusion (e.g. dashboard status filters).

## Also completed today (after this summary was first written)

7. **Found and fixed a real gap in repo hygiene**: the repo root (`~/pintag`) had no `.gitignore` at all — `pintag-studio/.gitignore`'s `.env*` rule only covers that subdirectory, not the parent, so `.env.local` at the repo root (holding real Supabase credentials) was untracked but *not* protected from a future `git add -A`. Added a minimal root-level `.gitignore` (`.env`, `.env.*`).

8. **Committed and pushed both fixes** to `origin/claude/pintag-marketing-ai-arch-rfq4a7`:
   - `e6b6e2b` — Guardian verdict-logic fix, plus the revised draft/research as evidence and this summary file.
   - `f0af550` — root-level `.gitignore`.
   - Confirmed via `git fetch` + `git log`/`git rev-list`: origin tip matches local tip exactly, 0 ahead/0 behind. No secrets were ever staged or committed.

9. **Founder approval + publish loop closed, end to end, against the real cloud project.** With your explicit go-ahead each step: set `decision='approved'`, `decided_at=now()` on the `approvals_queue` row (id `3b1308f0-16c3-4507-a3e0-7eab80f00b8e`), then ran `npm run pipeline:publish-queue`. Result: `content_items.status='published'`, `content_calendar.publish_status='published'` with `simulated=true` (no real Meta API call — `META_PUBLISH_MODE` still defaults to `simulate`, correct per `SETUP.md`), and a `performance_metrics` row was written (all zeros — honest placeholder for a simulated post with no real engagement, not a bug). `content_items.embedding` is still null, which is expected — embedding generation is explicitly M2 scope.

## Current state as of end of session

- **The full M1 loop has now run once, completely, against the real cloud Supabase project**: Plan → Research → Write → Guardian (2 passes) → Schedule → Founder Approval → Publish (simulated) → Analyze → Memory Update. Nothing left in a partial state for this item.
- All code changes (Guardian fix + root `.gitignore`) are committed **and pushed** to `origin/claude/pintag-marketing-ai-arch-rfq4a7`. Working tree is clean.
- `.env.local` (Supabase Dev project credentials, Transaction Pooler URL) is in place, gitignored at both the `pintag-studio/` and repo-root level — reusable next session without re-entering anything, and safe from accidental commits.
- `node_modules` installed (`npm install` was run fresh this session).

## Next steps to resume next session

1. **Optional cleanup**: decide whether the `content_items.status` cosmetic inconsistency (flagged above — `guardianReview()` overwrote `scheduled` back to `approved` on the pass-2 re-review, though `content_calendar`/`approvals_queue` stayed correct throughout) is worth fixing before M2, or can wait.
2. **Broader M1 verification**: this was one item through the pipeline once, successfully, on the first clean attempt. If "M1 verification" means more than a single successful run (e.g. multiple items, testing the revision-loop path where Guardian genuinely fails a draft twice, testing `max_revision_cycles`, or testing what happens when `policyCompliant` legitimately trips to `false` on a fresh draft), that's still open.
3. **M2 planning**: M1's goal (per `ARCHITECTURE.md`: "10 posts published, brand voice proven consistent") is now demonstrated end-to-end for 1 of 10 posts against the real project. Worth deciding whether to run more items through before calling M1 done, or move to M2 (Graphic Designer / visual assets) scope.
