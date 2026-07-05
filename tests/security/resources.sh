#!/usr/bin/env bash
# Pintag Security Framework — Resource Registry
# ─────────────────────────────────────────────────────────────────────────────
# Single source of truth for every known API resource.
# Update this file when Pintag gains new Edge Functions, tables, or buckets.
# It is sourced by helpers.sh (coverage report) and generate-manifest.sh.
#
# Types used in suite @covers tags:
#   fn:name      — Edge Function at /functions/v1/<name>
#   table:name   — PostgREST table at /rest/v1/<name>
#   bucket:name  — Storage bucket at /storage/v1/object/<name>
#   header:name  — HTTP security response header
#   static       — static / filesystem analysis (no network requests)
# ─────────────────────────────────────────────────────────────────────────────

FRAMEWORK_VERSION="1.0.0"
FRAMEWORK_RELEASE="2026-06-25"

# Edge Functions deployed under /functions/v1/
RESOURCE_FNS=(
  "generate-listing-content"
  "smart-listing-importer"
  "resolve-map-url"
)

# PostgREST-exposed tables under /rest/v1/
RESOURCE_TABLES=(
  "properties"
  "parties"
  "contacts"
  "lead_events"
  "listing_events"
)

# Storage buckets under /storage/v1/object/
RESOURCE_BUCKETS=(
  "property-images"
  "agent-photos"
)

# HTTP security headers verified in the headers suite (Suite 08)
RESOURCE_HEADERS=(
  "Content-Security-Policy"
  "X-Frame-Options"
  "X-Content-Type-Options"
  "Referrer-Policy"
  "Permissions-Policy"
  "Strict-Transport-Security"
)
