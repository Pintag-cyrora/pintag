// Stage 4 — Design. Produces on-brand static visuals via Canva Brand
// Templates, locked to brand-assets/ colors/fonts/logo.
//
// Corresponding agent: .claude/agents/graphic-designer.md
// Reads from: brand-assets/canva-templates.json
// Writes to: generated-content/.../assets/*.png

import type { Draft } from '../lib/types.js';

export interface DesignedAsset {
  path: string;
  canvaTemplateId: string;
}

export async function design(draft: Draft): Promise<DesignedAsset[]> {
  // TODO(M2): call the Canva Connect API (create-design-from-brand-template)
  // using the template id matching the item's content_type from
  // brand-assets/canva-templates.json; export and save into
  // generated-content/.../assets/. Skip entirely for property_video items
  // (Stage 5 produces the video thumbnail instead).
  void draft;
  return [];
}
