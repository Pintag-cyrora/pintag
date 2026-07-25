// Research cache (M3) — the Researcher is the most expensive reasoning call
// in a campaign, and near-identical topics keep recurring (the same
// confusion signal can surface several mornings in a row). A cache hit
// skips the Researcher's LLM call entirely and reuses the stored
// CampaignResearch; provenance is recorded on the campaign
// (research.reusedFromCache) so a reused grounding is never silently
// passed off as fresh.
//
// Keyed by the campaign topic's normalized slug — "nearly identical" means
// "normalizes to the same slug," a deterministic rule, not a similarity
// model. Validity window comes from brain/org-config.json
// (campaigns.research_cache_max_age_days).

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readCampaignConfig } from '../../lib/config.js';
import type { CampaignResearch } from './types.js';

const RESEARCH_DIR = join(REPO_ROOT, 'research');

interface CachedResearch {
  topic: string;
  researchedAt: string;
  research: CampaignResearch;
}

/** Same normalization as campaign ids — one rule for what counts as "the same topic." */
export function researchCacheKey(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'topic';
}

/** Returns still-valid cached research for this topic, or null. Corrupt/expired entries read as misses, never as errors. */
export function readCachedResearch(topic: string, now: Date = new Date()): { research: CampaignResearch; cacheFile: string; researchedAt: string } | null {
  const key = researchCacheKey(topic);
  const cacheFile = `research/${key}.json`;
  try {
    const cached = JSON.parse(readFileSync(join(RESEARCH_DIR, `${key}.json`), 'utf-8')) as CachedResearch;
    const ageDays = (now.getTime() - new Date(cached.researchedAt).getTime()) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > readCampaignConfig().researchCacheMaxAgeDays) return null;
    if (!cached.research || !Array.isArray(cached.research.facts)) return null;
    return { research: cached.research, cacheFile, researchedAt: cached.researchedAt };
  } catch {
    return null;
  }
}

/** Stores fresh research under the topic's key. The stored copy never includes reusedFromCache — a cache entry is always its own fresh provenance. */
export function writeCachedResearch(topic: string, research: CampaignResearch, now: Date = new Date()): void {
  mkdirSync(RESEARCH_DIR, { recursive: true });
  const { reusedFromCache: _ignored, ...fresh } = research;
  const entry: CachedResearch = { topic, researchedAt: now.toISOString(), research: fresh };
  writeFileSync(join(RESEARCH_DIR, `${researchCacheKey(topic)}.json`), JSON.stringify(entry, null, 2), 'utf-8');
}
