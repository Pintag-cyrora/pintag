// The Knowledge Suggestion System's backend — "the mailbox." Any current or
// future agent drops a candidate insight off here via proposeSuggestion();
// nothing becomes real knowledge until a human calls approveSuggestion() or
// rejectSuggestion(). This is the explicit earlier checkpoint the founder
// asked for: "the AI is not deciding what becomes knowledge, it is
// surfacing candidates for review." No UI reads this yet — that's a
// deliberate, separate future step (build the mailbox before the mailbox
// door).
//
// Storage is deliberately NOT under knowledge/ — a suggestion is explicitly
// not yet knowledge, and keeping it out of knowledge/ means
// loadAllKnowledgeEntries()'s directory walk can never accidentally surface
// an unreviewed suggestion as if it were a real entry. The closest existing
// precedent is generated-content/ (pre-Guardian staging for content); this
// is the same pattern one stage earlier, for knowledge.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.js';
import { proposeKnowledgeEntry, type KnowledgeEntry, type KnowledgeSourceType } from './knowledge.js';

export const SUGGESTIONS_ROOT = join(REPO_ROOT, 'knowledge-suggestions');

export type SuggestionKind = 'knowledge-gap' | 'recurring-question' | 'wording-improvement' | 'marketing-observation' | 'founder-teaching' | 'other';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected';

export interface SuggestionDiff {
  current: string;
  suggested: string;
}

export interface SuggestionOccurrence {
  date: string;
  context: string;
}

export interface KnowledgeSuggestion {
  id: string;
  kind: SuggestionKind;
  /** Which agent dropped this off — provenance, same idea as KnowledgeEntry.contributedBy. */
  sourceAgent: string;
  /** "What it found" — one line. */
  title: string;
  /** "Why it thinks it's valuable" — the reasoning/narrative. */
  body: string;
  /** For wording-improvement-shaped suggestions: the before/after. */
  diff?: SuggestionDiff;
  /** "Where it belongs" — a knowledge/ category path, e.g. "industries/real-estate". */
  suggestedCategory: string;
  suggestedTags: string[];
  /** 0-1, same convention as KnowledgeEntry.confidence. */
  confidence: number;
  /** Real, accumulating evidence — "observed in multiple research sessions" as data, not a static claim. */
  occurrences: SuggestionOccurrence[];
  status: SuggestionStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  /** Set on approval — links the suggestion to the KnowledgeEntry it became. */
  resultingKnowledgeEntryId?: string;
  created: string;
  updated: string;
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Same constrained frontmatter subset as knowledge.ts — see that file for why it's hand-rolled rather than a general YAML parser. */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Suggestion file is missing a --- frontmatter block: ${raw.slice(0, 80)}...`);
  const [, block, body] = match;
  const lines = block.split('\n');
  const meta: Record<string, unknown> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const top = line.match(/^(\w+):\s*(.*)$/);
    if (!top) {
      i++;
      continue;
    }
    const [, key, rest] = top;

    if (rest === '') {
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('  ')) {
        blockLines.push(lines[j].slice(2));
        j++;
      }
      if (blockLines.length === 0) {
        meta[key] = [];
      } else if (blockLines.every((l) => l.startsWith('- '))) {
        // Each "- " item may itself be "date: ... | context: ..." (occurrences) or a plain string (tags).
        meta[key] = blockLines.map((l) => {
          const item = l.slice(2).trim();
          const pipeParts = item.split(' | ').map((p) => p.trim());
          if (pipeParts.length > 1 && pipeParts.every((p) => /^\w+:/.test(p))) {
            const obj: Record<string, string> = {};
            for (const p of pipeParts) {
              const m = p.match(/^(\w+):\s*(.*)$/);
              if (m) obj[m[1]] = m[2];
            }
            return obj;
          }
          return item;
        });
      } else {
        const obj: Record<string, string> = {};
        for (const bl of blockLines) {
          const sub = bl.match(/^(\w+):\s*(.*)$/);
          if (sub) obj[sub[1]] = sub[2].trim();
        }
        meta[key] = obj;
      }
      i = j;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      meta[key] = inner === '' ? [] : inner.split(',').map((s) => s.trim());
      i++;
    } else if (/^-?\d+(\.\d+)?$/.test(rest)) {
      meta[key] = Number(rest);
      i++;
    } else {
      meta[key] = rest;
      i++;
    }
  }

  return { meta, body: body.trim() };
}

function toSuggestion(meta: Record<string, unknown>, body: string, filePath: string): KnowledgeSuggestion {
  const diffObj = meta.diff as Record<string, string> | undefined;
  const occurrencesRaw = Array.isArray(meta.occurrences) ? (meta.occurrences as unknown[]) : [];
  return {
    id: String(meta.id ?? ''),
    kind: (meta.kind as SuggestionKind) ?? 'other',
    sourceAgent: String(meta.sourceAgent ?? 'unknown'),
    title: String(meta.title ?? ''),
    body,
    diff: diffObj && diffObj.current !== undefined ? { current: diffObj.current, suggested: diffObj.suggested } : undefined,
    suggestedCategory: String(meta.suggestedCategory ?? ''),
    suggestedTags: Array.isArray(meta.suggestedTags) ? (meta.suggestedTags as string[]) : [],
    confidence: typeof meta.confidence === 'number' ? meta.confidence : Number(meta.confidence ?? 0.5),
    occurrences: occurrencesRaw.map((o) =>
      typeof o === 'object' && o !== null ? (o as SuggestionOccurrence) : { date: '', context: String(o) }
    ),
    status: (meta.status as SuggestionStatus) ?? 'pending',
    reviewedBy: meta.reviewedBy ? String(meta.reviewedBy) : undefined,
    reviewedAt: meta.reviewedAt ? String(meta.reviewedAt) : undefined,
    reviewNotes: meta.reviewNotes ? String(meta.reviewNotes) : undefined,
    resultingKnowledgeEntryId: meta.resultingKnowledgeEntryId ? String(meta.resultingKnowledgeEntryId) : undefined,
    created: String(meta.created ?? ''),
    updated: String(meta.updated ?? ''),
    filePath,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Loose match for dedupe: same kind + same normalized title. Good enough at this volume; a future semantic-similarity check is a K2-style upgrade, not needed now. */
function normalizeForDedupe(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function serializeSuggestion(s: KnowledgeSuggestion): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${s.id}`);
  lines.push(`kind: ${s.kind}`);
  lines.push(`sourceAgent: ${s.sourceAgent}`);
  lines.push(`title: ${s.title}`);
  lines.push(`status: ${s.status}`);
  lines.push(`confidence: ${s.confidence}`);
  lines.push(`suggestedCategory: ${s.suggestedCategory}`);
  lines.push(`suggestedTags: [${s.suggestedTags.join(', ')}]`);
  if (s.diff) {
    lines.push('diff:');
    lines.push(`  current: ${s.diff.current.replace(/\n+/g, ' ').trim()}`);
    lines.push(`  suggested: ${s.diff.suggested.replace(/\n+/g, ' ').trim()}`);
  }
  if (s.occurrences.length) {
    lines.push('occurrences:');
    for (const o of s.occurrences) {
      lines.push(`  - date: ${o.date} | context: ${o.context.replace(/\n+/g, ' ').trim()}`);
    }
  } else {
    lines.push('occurrences: []');
  }
  lines.push(`created: ${s.created}`);
  lines.push(`updated: ${s.updated}`);
  if (s.reviewedBy) lines.push(`reviewedBy: ${s.reviewedBy}`);
  if (s.reviewedAt) lines.push(`reviewedAt: ${s.reviewedAt}`);
  if (s.reviewNotes) lines.push(`reviewNotes: ${s.reviewNotes.replace(/\n+/g, ' ').trim()}`);
  if (s.resultingKnowledgeEntryId) lines.push(`resultingKnowledgeEntryId: ${s.resultingKnowledgeEntryId}`);
  lines.push('---', '', s.body, '');
  return lines.join('\n');
}

function walkSuggestionFiles(): string[] {
  try {
    return readdirSync(SUGGESTIONS_ROOT)
      .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
      .map((name) => join(SUGGESTIONS_ROOT, name))
      .filter((p) => statSync(p).isFile());
  } catch {
    return []; // knowledge-suggestions/ doesn't exist yet — nothing proposed so far.
  }
}

export function loadAllSuggestions(): KnowledgeSuggestion[] {
  return walkSuggestionFiles().map((filePath) => {
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    return toSuggestion(meta, body, filePath);
  });
}

export function listPendingSuggestions(): KnowledgeSuggestion[] {
  return loadAllSuggestions()
    .filter((s) => s.status === 'pending')
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function getSuggestionById(id: string): KnowledgeSuggestion | undefined {
  return loadAllSuggestions().find((s) => s.id === id);
}

function writeSuggestion(s: KnowledgeSuggestion): void {
  mkdirSync(SUGGESTIONS_ROOT, { recursive: true });
  writeFileSync(s.filePath, serializeSuggestion(s), 'utf-8');
}

export interface ProposeSuggestionInput {
  kind: SuggestionKind;
  sourceAgent: string;
  title: string;
  body: string;
  diff?: SuggestionDiff;
  suggestedCategory: string;
  suggestedTags?: string[];
  confidence?: number;
  /** What triggered this particular occurrence — e.g. "content_items abc123, brief: ...". */
  context: string;
}

/**
 * The mailbox drop-off — agent-agnostic, matching proposeKnowledgeEntry()'s
 * existing design principle. Dedupes on create: a pending suggestion with
 * the same kind + a normalized-title match gets this occurrence appended
 * instead of a near-duplicate file, which is what turns "observed in
 * multiple research sessions" into a real, accumulating signal.
 */
export function proposeSuggestion(input: ProposeSuggestionInput): KnowledgeSuggestion {
  const today = new Date().toISOString().slice(0, 10);
  const normalizedTitle = normalizeForDedupe(input.title);

  const existing = loadAllSuggestions().find(
    (s) => s.status === 'pending' && s.kind === input.kind && normalizeForDedupe(s.title) === normalizedTitle
  );

  if (existing) {
    const updated: KnowledgeSuggestion = {
      ...existing,
      updated: today,
      confidence: Math.min(0.95, existing.confidence + 0.05),
      occurrences: [...existing.occurrences, { date: today, context: input.context }],
    };
    writeSuggestion(updated);
    return updated;
  }

  const id = `${slugify(input.kind)}-${slugify(input.title)}-${Date.now().toString(36).slice(-5)}`;
  const suggestion: KnowledgeSuggestion = {
    id,
    kind: input.kind,
    sourceAgent: input.sourceAgent,
    title: input.title,
    body: input.body,
    diff: input.diff,
    suggestedCategory: input.suggestedCategory,
    suggestedTags: input.suggestedTags ?? [],
    confidence: input.confidence ?? 0.5,
    occurrences: [{ date: today, context: input.context }],
    status: 'pending',
    created: today,
    updated: today,
    filePath: join(SUGGESTIONS_ROOT, `${id}.md`),
  };
  writeSuggestion(suggestion);
  return suggestion;
}

export interface ApproveSuggestionInput {
  id: string;
  reviewedBy: string;
  reviewNotes?: string;
  /** Lets a human reshape the suggestion before it becomes a real KnowledgeEntry — the "Edit then Approve" flow. */
  edits?: {
    title?: string;
    body?: string;
    suggestedCategory?: string;
    suggestedTags?: string[];
  };
}

/**
 * Approval does NOT skip the existing draft->verified Review Queue — it
 * feeds it. This creates a real KnowledgeEntry via the existing
 * proposeKnowledgeEntry() (landing at status: 'draft', same as every other
 * capture path), then marks the suggestion approved with a link to what it
 * became. Two human checkpoints, not one: "is this worth considering"
 * (here) then "is this accurate enough to trust" (knowledge-review.ts).
 */
export function approveSuggestion(input: ApproveSuggestionInput): { suggestion: KnowledgeSuggestion; entry: KnowledgeEntry } {
  const suggestion = getSuggestionById(input.id);
  if (!suggestion) throw new Error(`No suggestion found with id "${input.id}"`);
  if (suggestion.status !== 'pending') {
    throw new Error(`Suggestion "${input.id}" is already ${suggestion.status} — only pending suggestions can be approved.`);
  }

  const title = input.edits?.title ?? suggestion.title;
  const body = input.edits?.body ?? suggestion.body;
  const category = input.edits?.suggestedCategory ?? suggestion.suggestedCategory;
  const tags = input.edits?.suggestedTags ?? suggestion.suggestedTags;

  const sourceType: KnowledgeSourceType = 'agent-inference';
  const entry = proposeKnowledgeEntry({
    category,
    title,
    body: suggestion.diff
      ? `${body}\n\nCurrent: ${suggestion.diff.current}\nSuggested: ${suggestion.diff.suggested}`
      : body,
    tags,
    source: { type: sourceType, reference: `knowledge-suggestions/${suggestion.id}.md` },
    contributedBy: suggestion.sourceAgent,
    confidence: suggestion.confidence,
  });

  const today = new Date().toISOString().slice(0, 10);
  const updatedSuggestion: KnowledgeSuggestion = {
    ...suggestion,
    status: 'approved',
    updated: today,
    reviewedBy: input.reviewedBy,
    reviewedAt: today,
    reviewNotes: input.reviewNotes,
    resultingKnowledgeEntryId: entry.id,
  };
  writeSuggestion(updatedSuggestion);

  return { suggestion: updatedSuggestion, entry };
}

export interface RejectSuggestionInput {
  id: string;
  reviewedBy: string;
  reason: string;
}

/** Never deletes the file — a rejected suggestion stays as a permanent record, same permanence principle as everywhere else in this system. */
export function rejectSuggestion(input: RejectSuggestionInput): KnowledgeSuggestion {
  const suggestion = getSuggestionById(input.id);
  if (!suggestion) throw new Error(`No suggestion found with id "${input.id}"`);
  if (suggestion.status !== 'pending') {
    throw new Error(`Suggestion "${input.id}" is already ${suggestion.status} — only pending suggestions can be rejected.`);
  }
  if (!input.reason) throw new Error('reason is required when rejecting a suggestion.');

  const today = new Date().toISOString().slice(0, 10);
  const updated: KnowledgeSuggestion = {
    ...suggestion,
    status: 'rejected',
    updated: today,
    reviewedBy: input.reviewedBy,
    reviewedAt: today,
    reviewNotes: input.reason,
  };
  writeSuggestion(updated);
  return updated;
}

/** Standalone edit without approving/rejecting — for symmetry with a future UI's separate "Edit" action. */
export function editSuggestion(
  id: string,
  edits: Partial<Pick<KnowledgeSuggestion, 'title' | 'body' | 'suggestedCategory' | 'suggestedTags' | 'diff'>>
): KnowledgeSuggestion {
  const suggestion = getSuggestionById(id);
  if (!suggestion) throw new Error(`No suggestion found with id "${id}"`);
  const updated: KnowledgeSuggestion = { ...suggestion, ...edits, updated: new Date().toISOString().slice(0, 10) };
  writeSuggestion(updated);
  return updated;
}
