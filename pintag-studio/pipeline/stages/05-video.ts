// Stage 5 — Video. Template-driven FFmpeg assembly by default (the primary
// path to the 500 property-video target); a pluggable premium-narration
// provider slot exists but is unused by default (see architecture doc).
//
// Corresponding agent: .claude/agents/video-producer.md
// Reads from: templates/property-video.template.json, listing photos (via
// the Pintag public-listings-feed), script from Stage 3, brand-assets/voice/
// Writes to: content-vault/property-videos/{listing-id}/render.mp4

import type { Draft } from '../lib/types.js';
import { supabase } from '../lib/supabase.js';
import { withHealthReport, reportHealth } from '../lib/health.js';

export interface VideoRenderResult {
  vaultPath: string;
  durationSeconds: number;
  narrationProvider: 'ffmpeg-tts' | 'premium';
}

export async function produceVideo(script: Draft, listingId: string): Promise<VideoRenderResult> {
  return withHealthReport('video_producer', async () => {
    // TODO(M4): build the scene list per templates/property-video.template.json
    // from the listing's photos, synthesize voiceover (Google Cloud TTS by
    // default), assemble with FFmpeg (Ken Burns pans, branded lower-thirds,
    // captions, licensed background music), write the render into
    // content-vault/property-videos/{listing-id}/.
    void script;
    void listingId;
    throw new Error('Not implemented — see TODO(M4)');
  });
}

// A queue-depth check is a proactive health signal, not an error — it
// doesn't fit the try/catch shape of withHealthReport, so it's a small
// standalone check instead. Call this on a schedule alongside produceVideo.
const QUEUE_BUILDING_THRESHOLD = 20;

export async function checkVideoQueueHealth(): Promise<void> {
  const { count } = await supabase
    .from('content_calendar')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', 'pintag')
    .eq('publish_status', 'queued');
  // TODO(M4): narrow this count to property_video items specifically via a
  // join on content_items.content_type once real videos are being queued.

  if ((count ?? 0) > QUEUE_BUILDING_THRESHOLD) {
    await reportHealth('video_producer', 'degraded', 'Queue building — rendering is falling behind schedule.');
  } else {
    await reportHealth('video_producer', 'healthy');
  }
}
