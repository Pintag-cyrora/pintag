#!/usr/bin/env bash
# verify-listings-count.sh — confirms the public listings page ("All
# Listings" view) is showing every listing the database actually has.
#
# Written after the incident where listings.html's default view silently
# hid every listing except one (fixed in commit b4a45a4). This script
# exercises the EXACT query listings.html's loadListings() sends
# (anon key, same filter/select), then compares it against an unfiltered
# row count, so a future regression that reintroduces client- OR server-
# side filtering shows up as a number mismatch here, not just a visual bug
# someone has to notice.
#
# Run from a machine with network access to Supabase (this cannot run from
# a sandboxed Claude Code session -- see README.md's environment notes).
#
# Usage:
#   SUPABASE_URL="https://<project-ref>.supabase.co" \
#   SUPABASE_ANON_KEY="<anon key, from config.prod.js>" \
#   ./scripts/verify-listings-count.sh
#
# Both values are already public/committed in config.prod.js -- nothing
# secret is required to run this.

set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL (see config.prod.js)}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (see config.prod.js)}"

hdr=(-H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_ANON_KEY}")

count_from_content_range() {
  # Prefer: count=exact makes PostgREST return a Content-Range header like
  # "0-24/137" -- the number after the slash is the true total row count
  # matching the filter, independent of the page size (Range: 0-0 asks for
  # just one row back, so this is a cheap HEAD-like count, not a full fetch).
  local url="$1"
  curl -s -D - -o /dev/null "${hdr[@]}" \
    -H "Prefer: count=exact" -H "Range: 0-0" "$url" \
    | grep -i '^content-range:' | sed -E 's#.*/([0-9]+).*#\1#' | tr -d '\r'
}

echo "Querying ${SUPABASE_URL} ..."
echo

# 1. The EXACT query listings.html's loadListings() sends today (All
#    Listings view -- excludes only workflow_status='draft').
public_view_count=$(count_from_content_range \
  "${SUPABASE_URL}/rest/v1/properties?or=(status.neq.draft,status.is.null)&select=id")

# 2. Every row in the table, no filter at all -- the true database total.
raw_total_count=$(count_from_content_range \
  "${SUPABASE_URL}/rest/v1/properties?select=id")

# 3. Rows excluded because they're drafts -- the only legitimate gap
#    between #1 and #2. Anything else in that gap is the bug class this
#    script exists to catch.
draft_count=$(count_from_content_range \
  "${SUPABASE_URL}/rest/v1/properties?status=eq.draft&select=id")

echo "Public 'All Listings' query returns:  ${public_view_count}"
echo "Raw total rows in properties:         ${raw_total_count}"
echo "  of which draft (correctly hidden):  ${draft_count}"
echo

expected=$((raw_total_count - draft_count))
if [[ "$public_view_count" == "$expected" ]]; then
  echo "OK: public_view_count (${public_view_count}) == raw_total - drafts (${expected})."
else
  echo "MISMATCH: public_view_count is ${public_view_count}, expected ${expected}."
  echo "Something besides the draft filter is excluding rows from the public query -- investigate before trusting the page."
  exit 1
fi

echo
echo "Manual final step: open https://pintag.io/listings.html, confirm 'All"
echo "Listings' is the active toggle, and confirm the on-page count ('N"
echo "listings') reads ${public_view_count}. If it does not, the regression"
echo "is back on the client side even though the API itself is correct."
