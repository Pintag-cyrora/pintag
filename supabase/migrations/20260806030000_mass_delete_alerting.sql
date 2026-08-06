-- ============================================================================
-- L1 SECURITY BASELINE (3/3): MASS-DELETE DETECTION + OPS ALERTS
-- ============================================================================
-- Finding (audit 2026-08-06): no alerting of any kind existed. On
-- 2026-08-03, 91 listings were deleted and nobody was told — the incident
-- was discovered by a human noticing, afterward.
--
-- This migration puts the tripwire in the database itself, where it cannot
-- be bypassed by any client:
--
--   * ops_alerts        — append-only alert log (admin read; written only
--                         by SECURITY DEFINER trigger functions).
--   * ops_alert_config  — single-row config holding an optional webhook URL
--                         (Telegram/Slack/Discord/etc.). When set and pg_net
--                         is available, alerts POST out within seconds of
--                         the event. When not set, alerts still land in
--                         ops_alerts and the monitoring workflow
--                         (.github/workflows/monitoring.yml) picks them up.
--   * Triggers on properties:
--       - ANY hard DELETE raises an alert. After 20260806020000 the
--         application never hard-deletes, so even ONE hard delete is an
--         anomaly worth waking someone for.
--       - A single statement hard-deleting >= 10 rows is BLOCKED
--         (exception → the whole statement rolls back). This is the
--         guard that would have stopped the incident cold. Legitimate
--         bulk maintenance can temporarily disable the trigger — a
--         deliberate, logged, two-step act instead of a silent default:
--           ALTER TABLE properties DISABLE TRIGGER trg_properties_mass_delete_guard;
--           -- ... maintenance ...
--           ALTER TABLE properties ENABLE TRIGGER trg_properties_mass_delete_guard;
--       - A single statement soft-deleting >= 5 rows raises an alert
--         (not blocked — soft deletes are reversible by definition).
--
-- Webhook delivery is best-effort (wrapped, never fails the transaction);
-- the ops_alerts INSERT is not wrapped — recording the alert is part of
-- the transaction's integrity.
--
-- Rollback:
--   DROP TRIGGER trg_properties_mass_delete_guard ON properties;
--   DROP TRIGGER trg_properties_mass_softdelete_alert ON properties;
--   (ops_alerts / ops_alert_config are additive; leave or drop.)
-- ============================================================================

BEGIN;

-- ── Alert log (append-only) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops_alerts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text        NOT NULL,   -- e.g. hard_delete, mass_delete_blocked, mass_soft_delete
  severity   text        NOT NULL CHECK (severity IN ('info','high','critical')),
  message    text        NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_created ON ops_alerts (created_at DESC);

ALTER TABLE ops_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read ops_alerts" ON ops_alerts;
CREATE POLICY "admin read ops_alerts" ON ops_alerts
  FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));
-- No INSERT/UPDATE/DELETE policies: written only via SECURITY DEFINER below.

-- ── Optional webhook destination (admin-managed) ────────────────────────────
CREATE TABLE IF NOT EXISTS ops_alert_config (
  id          int  PRIMARY KEY CHECK (id = 1),
  webhook_url text,                  -- POST target for alert JSON; NULL = log-only
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops_alert_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin all ops_alert_config" ON ops_alert_config;
CREATE POLICY "admin all ops_alert_config" ON ops_alert_config
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));
INSERT INTO ops_alert_config (id, webhook_url) VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

-- ── Raise an alert: always log; best-effort webhook ─────────────────────────
CREATE OR REPLACE FUNCTION _ops_raise_alert(
  p_kind text, p_severity text, p_message text, p_details jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url text;
BEGIN
  INSERT INTO ops_alerts (kind, severity, message, details)
  VALUES (p_kind, p_severity, p_message, p_details);

  -- Webhook: wrapped so a network/extension problem can never turn the
  -- alarm into an outage of the write path itself.
  BEGIN
    SELECT webhook_url INTO v_url FROM ops_alert_config WHERE id = 1;
    IF v_url IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
      PERFORM net.http_post(
        url     := v_url,
        body    := jsonb_build_object(
                     'source','pintag-db','kind',p_kind,'severity',p_severity,
                     'message',p_message,'details',p_details,'at',now()),
        headers := '{"Content-Type":"application/json"}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

-- ── Hard-delete tripwire + mass-delete guard ────────────────────────────────
CREATE OR REPLACE FUNCTION _properties_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM deleted_rows;
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  IF v_count >= 10 THEN
    -- The exception below rolls back this transaction — including any
    -- ops_alerts row or queued pg_net webhook (both are transactional).
    -- RAISE LOG is not: it lands in the Postgres logs regardless, so the
    -- blocked attempt is still on record (Supabase Dashboard → Logs).
    RAISE LOG 'PINTAG SECURITY EVENT mass_delete_blocked: statement attempted to hard-delete % properties rows (actor: %)',
      v_count, coalesce(auth.uid()::text, current_user);
    RAISE EXCEPTION
      'Mass hard-delete blocked: % rows in one statement (limit 10). Properties are soft-deleted (deleted_at), never bulk hard-deleted. For deliberate maintenance: ALTER TABLE properties DISABLE TRIGGER trg_properties_mass_delete_guard; ... re-enable after.',
      v_count;
  END IF;

  -- 1–9 rows: allowed (the row snapshots from 20260806020000 already
  -- captured them), but ANY hard delete is now an anomaly — alert.
  PERFORM _ops_raise_alert('hard_delete',
    CASE WHEN v_count >= 3 THEN 'critical' ELSE 'high' END,
    format('%s properties row(s) HARD-deleted (application only soft-deletes — investigate)', v_count),
    (SELECT jsonb_build_object('ids', jsonb_agg(d.id), 'actor', coalesce(auth.uid()::text, current_user)) FROM deleted_rows d));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_mass_delete_guard ON properties;
CREATE TRIGGER trg_properties_mass_delete_guard
  AFTER DELETE ON properties
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION _properties_delete_guard();

-- ── Mass soft-delete alert (reversible, so alert-only) ──────────────────────
CREATE OR REPLACE FUNCTION _properties_softdelete_alert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count
  FROM old_rows o JOIN new_rows n ON n.id = o.id
  WHERE o.deleted_at IS NULL AND n.deleted_at IS NOT NULL;
  IF v_count >= 5 THEN
    PERFORM _ops_raise_alert('mass_soft_delete','high',
      format('%s properties rows soft-deleted in one statement', v_count),
      jsonb_build_object('count', v_count, 'actor', coalesce(auth.uid()::text, current_user)));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_mass_softdelete_alert ON properties;
CREATE TRIGGER trg_properties_mass_softdelete_alert
  AFTER UPDATE ON properties
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION _properties_softdelete_alert();

COMMIT;

-- ── Verify (on a TEST project or with TEST rows) ────────────────────────────
-- 1. DELETE one test row       → allowed; ops_alerts gains kind='hard_delete'.
-- 2. DELETE 10+ test rows      → statement FAILS with the guard message.
-- 3. UPDATE 5+ rows SET deleted_at=now() → ops_alerts kind='mass_soft_delete'.
-- 4. Set a webhook: UPDATE ops_alert_config SET webhook_url='https://...' WHERE id=1;
--    repeat (1) → POST arrives within seconds.
