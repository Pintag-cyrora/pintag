`contact-intent-funnel.rpc-output*.json` are the **real output of `analytics_contact_intent_funnel()`**
against the controlled Postgres fixtures in `tests/security/regression/contact_intent_funnel_regression.sql`
(range 2026-10-08, plus an empty range). They freeze the SQL -> UI contract: the node tests feed them
to `contact-intent-funnel.js` so the dashboard model is checked against numbers the database actually
produced for known scenarios. Only the clock-dependent `range` flags (`today`, `includes_today`,
`outcomes_incomplete`) are pinned. Regenerate by re-running the regression and exporting `fx_result`.
