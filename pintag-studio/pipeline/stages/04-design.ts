// Stage 4 — Design. Produces on-brand static visuals via Canva Brand
// Templates, locked to brand-assets/ colors/fonts/logo.
//
// Corresponding agent: .claude/agents/graphic-designer.md
// Reads from: brand-assets/canva-templates.json
// Writes to: generated-content/.../assets/*.png

import type { Draft } from '../lib/types.js';
import { reportHealth } from '../lib/health.js';

export interface DesignedAsset {
  path: string;
  canvaTemplateId: string;
}

export async function design(draft: Draft): Promise<DesignedAsset[]> {
  try {
    // TODO(M2): call the Canva Connect API (create-design-from-brand-template)
    // using the template id matching the item's content_type from
    // brand-assets/canva-templates.json; export and save into
    // generated-content/.../assets/. Skip entirely for property_video items
    // (Stage 5 produces the video thumbnail instead).
    void draft;
    const assets: DesignedAsset[] = [];
    await reportHealth('graphic_designer', 'healthy');
    return assets;
  } catch {
    // TODO(M2): once the real Canva call exists, distinguish auth failures
    // from transient outages if the API response makes that possible.
    await reportHealth('graphic_designer', 'down', 'Canva API unavailable.');
    throw new Error('Canva API unavailable.');
  }
}
