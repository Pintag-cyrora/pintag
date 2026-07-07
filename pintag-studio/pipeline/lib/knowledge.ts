// The Knowledge Layer's Capture/Retrieval API — the one interface any
// agent (current or future) uses to read from and write to knowledge/.
//
// This is intentionally agent-agnostic: no function here knows or cares
// which employee is calling it. `contributedBy` records provenance as
// plain data, not as branching logic. That's what lets Writer, Brand
// Guardian, or a future tenant's agents start calling retrieveKnowledge()/
// proposeKnowledgeEntry() later with zero changes to this file.
//
// Storage today is flat markdown + frontmatter under knowledge/, scanned
// on every call. The data model is deliberately shaped like a future
// `knowledge_entries` Postgres table would be (see knowledge/README.md) —
// moving to pgvector-backed retrieval later is a storage-layer swap
// behind this same retrieveKnowledge()/proposeKnowledgeEntry() API, not a
// redesign of it. Compare to the Memory-layer dedupe stub in
// pipeline/stages/01-plan.ts (findSimilarByTitle, TODO(M2) for the real
// pgvector call) — same pattern, applied one layer up.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from './config.js';
import { loadLaoBrainDictionaryEntries } from './knowledge-sources/lao-brain.js';

export const KNOWLEDGE_ROOT = join(REPO_ROOT, 'knowledge');

export type KnowledgeStatus = 'draft' | 'verified' | 'expert_reviewed' | 'deprecated';

export type KnowledgeSourceType = 'file' | 'url' | 'agent-inference' | 'founder' | 'external-research';

export interface KnowledgeSource {
  type: KnowledgeSourceType;
  /** A file path (repo-relative), URL, or free-text description, depending on `type`. */
  reference: string;
}

export interface KnowledgeEntry {
  id: string;
  /** Folder path relative to knowledge/, e.g. "language", "industries/real-estate". */
  category: string;
  title: string;
  status: KnowledgeStatus;
  /** 0-1, same convention as org-config.json / quality_scores. */
  confidence: number;
  tags: string[];
  source: KnowledgeSource;
  /** Which agent or person produced this entry — provenance, distinct from `source` (what the claim is grounded in). */
  contributedBy: string;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  /** ISO date (YYYY-MM-DD). */
  updated: string;
  /** IDs of related entries — same lineage-tracking idea as content_items.derived_from/repurposed_into. */
  relatedIds: string[];
  /** Set when this entry has been replaced by a better one. Never delete the old entry — mirrors content-vault's superseded_by. */
  supersededBy?: string;
  body: string;
  /** Absolute path on disk, for debugging/traceability — not part of the portable entry data. */
  filePath: string;
}

const STATUS_RANK: Record<KnowledgeStatus, number> = {
  deprecated: 0,
  draft: 1,
  verified: 2,
  expert_reviewed: 3,
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parses the constrained frontmatter subset this module both writes and
 * reads (see serializeEntry below) — not general YAML. Supports flat
 * scalars, inline arrays (`key: [a, b, c]`), block arrays (`key:` then
 * `  - item` lines), and one level of nested object (`source:` then
 * `  type: ...` / `  reference: ...`).
 */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Knowledge entry is missing a --- frontmatter block: ${raw.slice(0, 80)}...`);
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
        meta[key] = blockLines.map((l) => l.slice(2).trim());
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

function toKnowledgeEntry(meta: Record<string, unknown>, body: string, filePath: string): KnowledgeEntry {
  const sourceObj = meta.source as Record<string, string> | undefined;
  return {
    id: String(meta.id ?? ''),
    category: String(meta.category ?? ''),
    title: String(meta.title ?? ''),
    status: (meta.status as KnowledgeStatus) ?? 'draft',
    confidence: typeof meta.confidence === 'number' ? meta.confidence : Number(meta.confidence ?? 0.5),
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    source: {
      type: (sourceObj?.type as KnowledgeSourceType) ?? 'agent-inference',
      reference: sourceObj?.reference ?? '',
    },
    contributedBy: String(meta.contributedBy ?? 'unknown'),
    created: String(meta.created ?? ''),
    updated: String(meta.updated ?? ''),
    relatedIds: Array.isArray(meta.relatedIds) ? (meta.relatedIds as string[]) : [],
    supersededBy: meta.supersededBy ? String(meta.supersededBy) : undefined,
    body,
    filePath,
  };
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name === 'README.md') continue; // _template.md, README.md are docs, not entries
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads and parses every knowledge entry from every source, merged into one
 * flat list. Today that's knowledge/**\/*.md plus brain/lao/dictionary.md
 * (via the lao-brain source adapter — see knowledge-sources/lao-brain.ts).
 * This is the one seam a future source (a Supabase-backed store, more
 * brain/lao/ files as they're populated) plugs into — callers of
 * retrieveKnowledge()/proposeKnowledgeEntry() never see which source an
 * entry came from, per the founder's explicit design goal.
 */
export function loadAllKnowledgeEntries(): KnowledgeEntry[] {
  const fileEntries = walkMarkdownFiles(KNOWLEDGE_ROOT).map((filePath) => {
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    return toKnowledgeEntry(meta, body, filePath);
  });
  return [...fileEntries, ...loadLaoBrainDictionaryEntries()];
}

export interface RetrieveKnowledgeOptions {
  /** Matches entries whose category equals, or is nested under (e.g. "industries" matches "industries/real-estate"), any of these. */
  categories?: string[];
  /** Entry must have at least one of these tags. */
  tags?: string[];
  /** Excludes entries below this status. Default 'draft' (no filtering by status). */
  minStatus?: KnowledgeStatus;
  limit?: number;
}

/**
 * The one retrieval entry point every agent should call before generating
 * content — a stand-in for the RAG/embeddings retrieval described as the
 * long-term vision (knowledge/README.md). Same call shape either way.
 */
export function retrieveKnowledge(options: RetrieveKnowledgeOptions = {}): KnowledgeEntry[] {
  const minRank = STATUS_RANK[options.minStatus ?? 'draft'];
  let entries = loadAllKnowledgeEntries().filter(
    (e) => STATUS_RANK[e.status] >= minRank && !e.supersededBy
  );

  if (options.categories?.length) {
    entries = entries.filter((e) =>
      options.categories!.some((c) => e.category === c || e.category.startsWith(`${c}/`))
    );
  }
  if (options.tags?.length) {
    entries = entries.filter((e) => e.tags.some((t) => options.tags!.includes(t)));
  }

  entries.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.confidence - a.confidence);
  return options.limit ? entries.slice(0, options.limit) : entries;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function serializeEntry(entry: KnowledgeEntry): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${entry.id}`);
  lines.push(`category: ${entry.category}`);
  lines.push(`title: ${entry.title}`);
  lines.push(`status: ${entry.status}`);
  lines.push(`confidence: ${entry.confidence}`);
  lines.push(`tags: [${entry.tags.join(', ')}]`);
  lines.push('source:');
  lines.push(`  type: ${entry.source.type}`);
  lines.push(`  reference: ${entry.source.reference}`);
  lines.push(`contributedBy: ${entry.contributedBy}`);
  lines.push(`created: ${entry.created}`);
  lines.push(`updated: ${entry.updated}`);
  lines.push(`relatedIds: [${entry.relatedIds.join(', ')}]`);
  if (entry.supersededBy) lines.push(`supersededBy: ${entry.supersededBy}`);
  lines.push('---', '', entry.body, '');
  return lines.join('\n');
}

export interface ProposeKnowledgeEntryInput {
  /** Folder path relative to knowledge/, e.g. "research", "language", "industries/real-estate". Created if it doesn't exist yet. */
  category: string;
  title: string;
  body: string;
  tags: string[];
  source: KnowledgeSource;
  /** Which agent or person is proposing this entry (provenance). */
  contributedBy: string;
  /** Defaults to 0.5 — a proposed entry is unverified by definition until a human or a higher-trust process reviews it. */
  confidence?: number;
  relatedIds?: string[];
}

/**
 * The stable, generic capture primitive: any current or future agent calls
 * this to turn a reusable insight (better wording, a customer objection, a
 * cultural note, a high-performing hook) into a structured entry instead of
 * leaving it in a log line or a chat transcript. Always writes status:
 * 'draft' — nothing enters knowledge/ pre-verified. Promoting a draft to
 * 'verified'/'expert_reviewed' is a deliberate human (or future review-
 * agent) action, matching the zero-tolerance-on-unverified-claims principle
 * already in place for published content (DEPARTMENT.md Tier 2).
 */
export function proposeKnowledgeEntry(input: ProposeKnowledgeEntryInput): KnowledgeEntry {
  const today = new Date().toISOString().slice(0, 10);
  const id = `${slugify(input.category)}-${slugify(input.title)}-${Date.now().toString(36).slice(-5)}`;

  const entry: KnowledgeEntry = {
    id,
    category: input.category,
    title: input.title,
    status: 'draft',
    confidence: input.confidence ?? 0.5,
    tags: input.tags,
    source: input.source,
    contributedBy: input.contributedBy,
    created: today,
    updated: today,
    relatedIds: input.relatedIds ?? [],
    body: input.body,
    filePath: join(KNOWLEDGE_ROOT, input.category, `${id}.md`),
  };

  mkdirSync(join(KNOWLEDGE_ROOT, input.category), { recursive: true });
  writeFileSync(entry.filePath, serializeEntry(entry), 'utf-8');

  return entry;
}

/** For debugging/tooling: the entry's path relative to KNOWLEDGE_ROOT, e.g. "language/lo-property-terms-a1b2c.md". */
export function relativeKnowledgePath(entry: KnowledgeEntry): string {
  return relative(KNOWLEDGE_ROOT, entry.filePath).split(sep).join('/');
}
