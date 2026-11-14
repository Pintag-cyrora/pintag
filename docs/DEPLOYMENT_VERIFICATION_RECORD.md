# Deployment allowlist — live verification record

This is the register of **live** verifications of the production deployment allowlist (`docs/DEPLOYMENT_ALLOWLIST.md`, "Post-deployment verification").
Only an authorized operator adds a row, by pasting the RECORD block printed by `scripts/verify-site-exclusions.sh`. A row is evidence only for the date, site and commit it names.
Rules: an entry with no operator is invalid; `INCOMPLETE` (unverifiable checks, usually a Cloudflare challenge) and `FAILED` stay open with their outstanding items listed and are never
reworded as passes; a later `PASSED` row does not delete earlier rows.

**Current state: NO live verification has been performed or recorded.** The allowlist has not been deployed from this record's point of view; the table is intentionally empty.

**Accepted risk (not a verification result).** The single administrator email address remaining in `admin-auth.js` is temporarily accepted by the owner (2026-11-04). This is an accepted exposure, not a passed security control, and it is not a verification entry. It is limited strictly to that address; no other personal information, credentials, tokens or secrets are covered. It must be revisited when server-side authorization can replace the client-side email check. See `docs/DEPLOYMENT_ALLOWLIST.md`.

| Date (UTC) | Operator | Site | Deployed commit | Result | Outstanding failures / unverifiable paths | Notes |
|---|---|---|---|---|---|---|
| _none_ | | | | | | |

## Template for a row
`| 2026-MM-DD HH:MM | Full Name | https://pintag.io | <40-character commit> | PASSED / FAILED / INCOMPLETE (n passed, n failed, n unverifiable) | one line per outstanding path, or "none" | anything the operator did by hand (browser checks) |`
