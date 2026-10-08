`contact-intent-funnel.rpc-output*.json` are the **real output of `analytics_contact_intent_funnel()`** against
the controlled Postgres fixtures in `tests/security/regression/` (only the clock-dependent `range` flags
`today`, `includes_today`, `outcomes_incomplete` are pinned). They freeze the SQL -> UI contract: the node
tests feed them to `contact-intent-funnel.js` so the dashboard model is checked against numbers the database
actually produced for known scenarios.

| file | produced by | what it is |
|---|---|---|
| `.rpc-output.json` | v2 function, `contact_intent_funnel_regression.sql` (Laos 2026-10-08) | every v1 scenario; resolution keys present and zero |
| `.rpc-output.empty.json` | v2 function, an empty range | all zeros, empty arrays |
| `.rpc-output.resolution.json` | v2 function, `contact_intent_resolution_regression.sql` (Laos 2026-10-15) | Terms / Price & deposit answered vs escalated, topics, Ask-the-agent clicks |
| `.v1.json`, `.empty.v1.json` | the ORIGINAL v1 function | a payload with NO `resolution` block: proves the dashboard still renders if migration 20261009000000 is not applied yet |

Regenerate by re-running the regression and exporting `fx_result` / `rr_result`.
