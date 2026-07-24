// Persistence for MorningBrief — the canonical structured JSON, not any
// rendered output. daily-briefing/latest.json is what GET /morning reads
// instantly; daily-briefing/{dateISO}.json is a permanent, one-per-day
// historical snapshot, mirroring the existing {date}.md + latest.md
// pattern so JSON gets the same historical record for future
// analytics/timeline views.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../lib/config.js';
import type { MorningBrief } from './types.js';

const BRIEFING_DIR = join(REPO_ROOT, 'daily-briefing');
const LATEST_JSON_PATH = join(BRIEFING_DIR, 'latest.json');

export function writeMorningBrief(brief: MorningBrief): void {
  mkdirSync(BRIEFING_DIR, { recursive: true });
  const json = JSON.stringify(brief, null, 2);
  writeFileSync(LATEST_JSON_PATH, json, 'utf-8');
  writeFileSync(join(BRIEFING_DIR, `${brief.dateISO}.json`), json, 'utf-8');
}

export function readLatestMorningBrief(): MorningBrief | null {
  if (!existsSync(LATEST_JSON_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LATEST_JSON_PATH, 'utf-8')) as MorningBrief;
  } catch {
    return null;
  }
}

export function isMorningBriefStale(brief: MorningBrief, thresholdMinutes: number, now: Date = new Date()): boolean {
  const ageMinutes = (now.getTime() - new Date(brief.generatedAt).getTime()) / 60_000;
  return ageMinutes >= thresholdMinutes;
}
