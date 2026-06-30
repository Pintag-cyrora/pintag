-- FIX: reset_weekly_views() was GRANTED to the `authenticated` role, meaning
-- any logged-in agent could zero out weekly view counters for all properties.
-- Add an admin-only guard inside the SECURITY DEFINER function.

CREATE OR REPLACE FUNCTION reset_weekly_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.email() != 'admin@pintag.io' THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;
  UPDATE properties SET views_week = 0;
END;
$$;

-- Grant remains (Supabase needs it to route the call), but the function
-- enforces admin-only internally via auth.email().
