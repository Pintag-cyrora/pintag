// Stage 5 — Video. Template-driven FFmpeg assembly by default (the primary
// path to the 500 property-video target); a pluggable premium-narration
// provider slot exists but is unused by default (see architecture doc).
//
// Corresponding agent: .claude/agents/video-producer.md
// Reads from: templates/property-video.template.json, listing photos (via
// the Pintag public-listings-feed), script from Stage 3, brand-assets/voice/
// Writes to: content-vault/property-videos/{listing-id}/render.mp4

import type { Draft } from '../lib/types.js';

export interface VideoRenderResult {
  vaultPath: string;
  durationSeconds: number;
  narrationProvider: 'ffmpeg-tts' | 'premium';
}

export async function produceVideo(script: Draft, listingId: string): Promise<VideoRenderResult> {
  // TODO(M4): build the scene list per templates/property-video.template.json
  // from the listing's photos, synthesize voiceover (Google Cloud TTS by
  // default), assemble with FFmpeg (Ken Burns pans, branded lower-thirds,
  // captions, licensed background music), write the render into
  // content-vault/property-videos/{listing-id}/.
  void script;
  void listingId;
  throw new Error('Not implemented — see TODO(M4)');
}
