#!/usr/bin/env bash
# seed-dev-lib.sh -- what the development database may receive from production, and how it is copied. Sourced by scripts/seed-dev-from-prod.sh (which owns the
# project-ref safety gate and the confirmation prompt). Expects the caller to define psql_prod and psql_dev (functions that run psql against each database).
#
# DESIGN: an ALLOWLIST of columns. A production column that is not listed here is NOT copied (it keeps its default in dev) and its NAME is reported, so a column added
# to production later can never leak into the public development database by accident. The previous script copied `SELECT *` and redacted only contact phone numbers,
# which also copied every listing's exact map link and coordinates, third-party video/post links, the owner link and internal notes, and every agent's phone/email.
#
# NEVER COPIED (even if someone adds them to an allowlist, the leak guard below aborts the run):
#   properties: map_embed_url, latitude, longitude (exact location), download_url, video_url, video_embed_url, facebook_video_url (third-party links that
#               identify the place or the owner), owner_id, notes, nearby_places and neighborhood_* (named landmarks), view counters, price_previous
#   parties:    auth_user_id, email, created_by (accounts); phone and whatsapp are replaced by a placeholder number
#   contacts:   created_by; name is replaced by a role label; phone and whatsapp are replaced by a placeholder number
# ROWS: only published listings (not soft-deleted, status active/available). Soft-deleted rows, drafts and archived listings are not copied.
# FREE TEXT: map links that appear inside titles or descriptions are replaced by "[map link removed]". Descriptions may still contain an address typed in words;
# that cannot be detected reliably (see docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md, section 7). Listing photos keep pointing at production's already-public storage.

SEED_PLACEHOLDER_PHONE='0000000000'
SEED_PARTIES_COPY="id type slug name_en name_lo name_zh photo_url agency_name bio_en bio_lo bio_zh is_verified is_active languages created_at updated_at"
SEED_PARTIES_FAKE="phone whatsapp"
SEED_CONTACTS_COPY="id role party_id is_verified verified_at languages created_at updated_at"
SEED_PROPERTIES_COPY="id slug title_en title_lo title_zh description_en description_lo description_zh property_type property_style transaction_type status workflow_status market_status market_status_changed_at status_changed_at available_from price_amount price_currency price_frequency price_display sale_price rent_price rent_period rent_price_amount rent_price_currency rent_price_frequency rent_price_daily rent_price_3mo rent_price_6mo rent_price_12mo lease_price_basis district district_en district_lo district_zh province_en province_lo province_zh village village_en bedrooms bathrooms sqm sqm_land furnished floors parking_spaces year_built land_best_use land_category land_length_m land_shape land_terrain land_width_m road_frontage_m road_surface road_width_m land_title_type existing_structure images images_watermarked amenities features highlights property_highlight property_highlight_en property_highlight_lo property_highlight_zh agent_title managed_by_party_id contact_id is_featured rental_terms created_at"
SEED_TEXT_REDACT="title_en title_lo title_zh description_en description_lo description_zh property_highlight property_highlight_en property_highlight_lo property_highlight_zh"
# a column with any of these names must never be exported, whatever the allowlists say
SEED_FORBIDDEN="map_embed_url latitude longitude download_url video_url video_embed_url facebook_video_url owner_id notes nearby_places neighborhood_description neighborhood_insight_en neighborhood_insight_lo neighborhood_insight_zh auth_user_id email created_by view_count views_week price_previous"
SEED_MAPLINK_RE='https?://[^[:space:]"'"'"')]*(google\.[a-z.]+/maps|goo\.gl|maps\.app\.goo\.gl|g\.co/)[^[:space:]"'"'"')]*'

_seed_cols() {   # $1 = table, $2 = db (prod|dev) -> that table's column names, one per line (catalog read only)
  local fn="psql_$2"
  "$fn" -Atq -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' ORDER BY ordinal_position"
}
_seed_intersect() {   # $1 = table, $2 = allowlist -> allowlisted columns that exist in BOTH databases (allowlist order). Reports, by NAME only, what is not copied.
  local t="$1" want="$2" prod dev c out="" skipped=""
  prod="$(_seed_cols "$t" prod)"; dev="$(_seed_cols "$t" dev)"
  for c in $want; do
    if grep -qx "$c" <<<"$prod" && grep -qx "$c" <<<"$dev"; then out="$out $c"; fi
  done
  for c in $prod; do
    grep -qwx -- "$c" < <(tr ' ' '\n' <<<"$want") || skipped="$skipped $c"
  done
  echo "  $t: copying $(wc -w <<<"$out" | tr -d ' ') columns; NOT copied (production columns outside the allowlist):${skipped:- none}" >&2
  echo "${out# }"
}
_seed_assert_clean() {   # $1 = column list -> abort if any forbidden column is about to be exported
  local c f
  for c in $1; do for f in $SEED_FORBIDDEN; do
    if [[ "$c" == "$f" ]]; then echo "REFUSING: '$c' is on the never-copy list and appears in an export list. Remove it from the allowlist." >&2; return 1; fi
  done; done
}
_seed_redact_expr() {   # $1 = column -> the SELECT expression (map links inside free text removed)
  local c="$1" r
  for r in $SEED_TEXT_REDACT; do
    if [[ "$c" == "$r" ]]; then echo "regexp_replace($c, '${SEED_MAPLINK_RE//\'/\'\'}', '[map link removed]', 'gi') AS $c"; return; fi
  done
  echo "$c"
}
_seed_scan_file() {   # $1 = exported CSV -> abort if a map link or a coordinate pair survived into it (counts only, never the match)
  local f="$1" n
  n="$(grep -Eic "$SEED_MAPLINK_RE" "$f" || true)"
  if [[ "${n:-0}" -gt 0 ]]; then echo "REFUSING: $(basename "$f") still contains $n line(s) with a map link after redaction. Nothing was imported." >&2; return 1; fi
  n="$(grep -Ec '(^|[^0-9])1[3-9]\.[0-9]{4,}, ?10[0-8]\.[0-9]{4,}' "$f" || true)"
  if [[ "${n:-0}" -gt 0 ]]; then echo "REFUSING: $(basename "$f") contains $n line(s) that look like a coordinate pair. Nothing was imported." >&2; return 1; fi
}

# seed_copy_data WORKDIR -- export a redacted copy from production into WORKDIR, then (and only then) truncate and import into dev.
seed_copy_data() {
  local W="$1" pc cc prc pubs sel c
  echo "== Planning the copy (column catalog only; names, no data) =="
  pc="$(_seed_intersect parties "$SEED_PARTIES_COPY")"
  cc="$(_seed_intersect contacts "$SEED_CONTACTS_COPY")"
  prc="$(_seed_intersect properties "$SEED_PROPERTIES_COPY")"
  _seed_assert_clean "$pc $cc $prc" || return 1
  pubs="deleted_at IS NULL AND status IN ('active','available')"
  echo "== Exporting redacted data from production (read-only; nothing is written back) =="
  # parties: allowlisted columns, phone/whatsapp replaced by a placeholder
  sel=""; for c in $pc; do sel="$sel, $c"; done
  local fake=""; for c in $SEED_PARTIES_FAKE; do if grep -qx "$c" <<<"$(_seed_cols parties prod)" && grep -qx "$c" <<<"$(_seed_cols parties dev)"; then fake="$fake, '$SEED_PLACEHOLDER_PHONE' AS $c"; fi; done
  psql_prod -c "\\copy (SELECT ${sel#, }$fake FROM parties) TO '$W/parties.csv' WITH (FORMAT csv, HEADER true)"
  # contacts: only those a copied listing uses; name becomes a role label; phones are placeholders
  sel=""; for c in $cc; do sel="$sel, $c"; done
  psql_prod -c "\\copy (SELECT ${sel#, }, initcap(replace(role,'_',' ')) || ' (dev)' AS name, '$SEED_PLACEHOLDER_PHONE' AS phone, '$SEED_PLACEHOLDER_PHONE' AS whatsapp FROM contacts WHERE id IN (SELECT contact_id FROM properties WHERE contact_id IS NOT NULL AND $pubs)) TO '$W/contacts.csv' WITH (FORMAT csv, HEADER true)"
  # properties: allowlisted columns, published rows only, map links inside free text removed
  sel=""; for c in $prc; do sel="$sel, $(_seed_redact_expr "$c")"; done
  psql_prod -c "\\copy (SELECT ${sel#, } FROM properties WHERE $pubs) TO '$W/properties.csv' WITH (FORMAT csv, HEADER true)"
  local f; for f in parties contacts properties; do _seed_assert_clean "$(head -n1 "$W/$f.csv" | tr ',' ' ')" || return 1; _seed_scan_file "$W/$f.csv" || return 1; done
  echo "== Reseeding pintag-dev =="
  psql_dev -c "TRUNCATE properties, contacts, parties RESTART IDENTITY CASCADE;"
  for f in parties contacts properties; do
    psql_dev -c "\\copy $f($(head -n1 "$W/$f.csv")) FROM '$W/$f.csv' WITH (FORMAT csv, HEADER true)"
  done
}
