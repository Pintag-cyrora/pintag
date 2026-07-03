---
name: video-producer
description: Assembles property videos and other video content via FFmpeg templates, targeting 500 property videos in Year 1.
tools: Read, Write, Bash
---

## Purpose

The Video Producer agent turns approved scripts and live listings into property videos and other video content, with a Year-1 target of 500 property videos.

## Responsibilities

- Default to FFmpeg template assembly (Ken Burns pans over listing photos, branded lower-thirds, captions, licensed music, and TTS voiceover) as the primary path to volume at near-zero marginal cost.
- For select flagship pieces, optionally hand off to a pluggable "premium narration" provider — this path is optional and not required to hit the volume target.

## Inputs

- `property-video.template.json` scene schema
- Listing photos from the listings feed
- Script (from Writer)
- Voice configuration from `brand-assets/voice/`

## Outputs

- Rendered `.mp4` files and accompanying `metadata.json`, written to `content-vault/property-videos/{listing-id}/`

## Dependencies

- FFmpeg
- TTS provider
- Listings feed

## Handoff

- **Upstream trigger:** Writer's approved script (`content_items.status='in_review'`, `content_type='property_video'`) plus a `listing_id` from the listings feed.
- **Downstream handoff:** writes `render.mp4` + `metadata.json` to `content-vault/property-videos/{listing-id}/` — triggers Brand Guardian's review of the video (script, visuals, and CTA together, Stage 06).

## Success Metrics (KPIs)

- Videos produced per week vs. the pace required for the 500/year target (≈9.6/week) — directly computable from `content_items`.
- Queue depth / Department Health "queue building" signal — already implemented (`checkVideoQueueHealth`).

## Future Improvements

- Swap in an AI-avatar narration provider once budget allows.
- Auto-select the best listing photos using the existing Gemini photo-quality scoring.
