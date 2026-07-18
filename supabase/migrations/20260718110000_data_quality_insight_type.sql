-- Phase 2A (Alerts): adds 'data_quality' as an allowed intelligence_insights
-- type, backing the new rule-based data-quality detector (missing photos,
-- missing AI-generated highlight/description, stale listings). Purely
-- additive -- widens an existing CHECK constraint, touches no existing rows,
-- adds no new table. See
-- supabase/functions/generate-intelligence-report/data-quality-detector.js
-- and docs/intelligence/DETECTOR_ARCHITECTURE.md.

ALTER TABLE intelligence_insights DROP CONSTRAINT IF EXISTS intelligence_insights_type_check;
ALTER TABLE intelligence_insights ADD CONSTRAINT intelligence_insights_type_check
  CHECK (type IN (
    'demand_spike','supply_shortage','ctr_decline','ctr_improvement',
    'high_performing_listing','low_performing_listing','ux_anomaly',
    'conversion_anomaly','search_trend','price_trend','data_quality'
  ));
