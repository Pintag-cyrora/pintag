// Source adapter: reads brain/lao/dictionary.md (Keomany's hand-built Lao
// real estate dictionary — see brain/lao/README.md) and maps its entries
// into the same KnowledgeEntry shape everything in knowledge/ uses, so
// retrieveKnowledge() can merge both sources transparently. This is exactly
// the "storage-layer swap behind a stable API" seam knowledge.ts is built
// around — brain/lao/ is a second storage backend, not a special case
// callers need to know about.
//
// Per the founder's explicit Phase 1 decision: brain/lao/ stays exactly as
// it is — nothing here rewrites or duplicates its content into knowledge/.
// This file only *reads* it. Phase 2 (a real migration, preserving every
// entry and its richer per-term template) is a deliberate future step, not
// done here. See knowledge/README.md "Relationship to brain/lao/".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { KnowledgeEntry, KnowledgeStatus } from '../knowledge.js';

const DICTIONARY_PATH = join(REPO_ROOT, 'brain', 'lao', 'dictionary.md');

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** "ໃບຕາດິນ — bai ta din" -> "bai ta din". Falls back to the raw field if there's no em-dash transliteration to slugify from. */
function extractTransliteration(laoTermField: string): string {
  const parts = laoTermField.split('—').map((p) => p.trim());
  return parts.length > 1 && parts[1] ? parts[1] : laoTermField;
}

function parseTableRow(line: string): [string, string] | null {
  const m = line.match(/^\|(.+)\|$/);
  if (!m) return null;
  const cells = m[1].split('|').map((c) => c.trim());
  if (cells.length !== 2) return null;
  return [cells[0].replace(/\*\*/g, '').trim(), cells[1].trim()];
}

function mapStatus(raw: string | undefined): KnowledgeStatus {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'expert reviewed' || s === 'expert_reviewed') return 'expert_reviewed';
  if (['verified', 'founder-reviewed', 'founder reviewed', 'reviewed', 'approved'].includes(s)) return 'verified';
  if (s === 'deprecated') return 'deprecated';
  return 'draft'; // brain/lao/dictionary.md entries are all currently "Draft" — this is the honest default, not a guess.
}

/**
 * brain/lao/ has no numeric confidence field (its own lifecycle model is
 * Status + Legal Verification, per metadata.md). This derives a comparable
 * 0-1 value so it sorts sensibly alongside knowledge/ entries in
 * retrieveKnowledge() — a status-based baseline, capped lower when Legal
 * Verification is still "Pending" (a term can be in everyday-usage-accurate
 * while its legal implications are still unconfirmed, per the dictionary's
 * own "Common mistakes" notes on several entries).
 */
function deriveConfidence(status: KnowledgeStatus, legalVerification: string | undefined): number {
  const base: Record<KnowledgeStatus, number> = { draft: 0.5, verified: 0.8, expert_reviewed: 0.95, deprecated: 0.2 };
  const lv = (legalVerification ?? '').trim().toLowerCase();
  if (lv === '' || lv === 'pending') return Math.min(base[status], 0.5);
  return base[status];
}

function buildEntry(
  laoHeading: string,
  group: string,
  fields: Record<string, string>,
  preferredWording: string[],
  relatedKnowledge: string[]
): KnowledgeEntry | null {
  const laoTerm = fields['Lao term'] ?? laoHeading;
  const english = fields['Closest English Equivalent'] ?? '';
  if (!fields['Definition']) return null; // malformed/incomplete entry — skip rather than surface a broken one

  const transliteration = extractTransliteration(laoTerm);
  const status = mapStatus(fields['Status']);
  const tags = (fields['Tags']?.match(/`([^`]+)`/g) ?? []).map((t) => t.replace(/`/g, ''));
  tags.push('lao-dictionary', slugify(group));

  const bodyParts = [
    `**${laoTerm}**${english ? ` — ${english}` : ''}`,
    fields['Definition'],
    fields['When to use'] ? `**When to use:** ${fields['When to use']}` : '',
    fields['When not to use'] ? `**When not to use:** ${fields['When not to use']}` : '',
    fields['Common mistakes'] ? `**Common mistakes:** ${fields['Common mistakes']}` : '',
    fields['Example Usage'] ? `**Example usage:** ${fields['Example Usage']}` : '',
    preferredWording.length ? `**Preferred Pintag wording:**\n${preferredWording.map((w) => `- ${w}`).join('\n')}` : '',
    relatedKnowledge.length ? `**Related knowledge (in brain/lao/):**\n${relatedKnowledge.map((r) => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean);

  return {
    id: `lao-dictionary-${slugify(transliteration || english || laoHeading)}`,
    category: 'language',
    title: english ? `${english} (${laoTerm})` : laoTerm,
    status,
    confidence: deriveConfidence(status, fields['Legal Verification']),
    tags,
    source: {
      type: 'file',
      reference: `brain/lao/dictionary.md — ${fields['Source'] ?? 'source not recorded'}`,
    },
    contributedBy: 'brain/lao (Keomany, hand-authored)',
    created: '',
    updated: '',
    relatedIds: [],
    body: bodyParts.join('\n\n'),
    filePath: DICTIONARY_PATH,
  };
}

/**
 * Parses brain/lao/dictionary.md's frozen per-entry table template (see its
 * own header comment and brain/lao/README.md) into KnowledgeEntry objects.
 * Defensive by design: brain/lao/ is hand-edited prose, not a format this
 * codebase controls, so a missing file or an entry that doesn't match the
 * expected shape is skipped rather than crashing knowledge retrieval for
 * everything else.
 */
export function loadLaoBrainDictionaryEntries(): KnowledgeEntry[] {
  let raw: string;
  try {
    raw = readFileSync(DICTIONARY_PATH, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n');
  const entries: KnowledgeEntry[] = [];
  let currentGroup = '';
  let i = 0;

  while (i < lines.length) {
    const groupMatch = lines[i].match(/^## (.+)$/);
    if (groupMatch) {
      if (groupMatch[1].trim() !== 'Allowed Tags') currentGroup = groupMatch[1].trim();
      i++;
      continue;
    }

    const entryMatch = lines[i].match(/^### (.+)$/);
    if (!entryMatch || !currentGroup) {
      i++;
      continue;
    }

    const laoHeading = entryMatch[1].trim();
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (!lines[i]?.startsWith('|')) continue; // no table under this heading — not a dictionary entry (shouldn't happen, but stay defensive)
    i++; // header row
    if (lines[i]?.match(/^\|[-\s|]+\|$/)) i++; // separator row

    const fields: Record<string, string> = {};
    while (i < lines.length && lines[i].startsWith('|')) {
      const row = parseTableRow(lines[i]);
      if (row) fields[row[0]] = row[1];
      i++;
    }

    while (i < lines.length && lines[i].trim() === '') i++;
    const preferredWording: string[] = [];
    if (lines[i]?.trim() === '**Preferred Pintag Wording**') {
      i++;
      while (i < lines.length && lines[i].trim().startsWith('-')) {
        preferredWording.push(lines[i].trim().replace(/^-\s*/, ''));
        i++;
      }
    }

    while (i < lines.length && lines[i].trim() === '') i++;
    const relatedKnowledge: string[] = [];
    if (lines[i]?.trim() === '**Related Knowledge**') {
      i++;
      while (i < lines.length && lines[i].trim().startsWith('-')) {
        relatedKnowledge.push(lines[i].trim().replace(/^-\s*/, ''));
        i++;
      }
    }

    const entry = buildEntry(laoHeading, currentGroup, fields, preferredWording, relatedKnowledge);
    if (entry) entries.push(entry);
  }

  return entries;
}
