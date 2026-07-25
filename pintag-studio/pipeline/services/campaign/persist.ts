// Persistence for Campaign — the canonical structured JSON, same discipline
// as services/morning/persist.ts. Campaigns live in the Content Vault
// (content-vault/campaigns/<id>/campaign.json) because a campaign IS
// produced content — permanent, never deleted, superseded rather than
// removed (CLAUDE.md ground rule). Written after every step, not once at
// the end, so a crash mid-run loses at most the step in flight and the
// partial campaign remains inspectable.

import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../lib/config.js';
import type { Campaign } from './types.js';

const CAMPAIGNS_DIR = join(REPO_ROOT, 'content-vault', 'campaigns');

export function writeCampaign(campaign: Campaign): void {
  const dir = join(CAMPAIGNS_DIR, campaign.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(campaign, null, 2), 'utf-8');
}

export function readCampaign(id: string): Campaign | null {
  // Rejects anything that isn't a flat directory name before it touches the
  // filesystem — this id arrives straight from a URL path segment.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, id, 'campaign.json'), 'utf-8')) as Campaign;
  } catch {
    return null;
  }
}

/** Every campaign on disk, newest first by createdAt. Unreadable/corrupt entries are skipped, not fatal. */
export function listCampaigns(): Campaign[] {
  let ids: string[];
  try {
    ids = readdirSync(CAMPAIGNS_DIR);
  } catch {
    return [];
  }
  return ids
    .map((id) => readCampaign(id))
    .filter((c): c is Campaign => c !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The campaign the /research, /content, /video, /publish tabs show — the most recently created one, regardless of status (a running or failed campaign is still the founder's current context). */
export function readLatestCampaign(): Campaign | null {
  return listCampaigns()[0] ?? null;
}
