// Pattern Registry (M2.6) — Emerging Playbooks. When the same winning
// marketing pattern recurs across different posts, this turns it into a
// nameable, evidence-backed candidate the founder can approve into durable
// organizational knowledge, ignore, or keep observing. Same storage
// discipline as knowledge-suggestions/ (pipeline/lib/suggestions.ts):
// git-committed markdown + frontmatter, never silently deleted.
//
// Architecture, per the founder's own explicit design (this is not a
// redesign, it's exactly what was asked for): a deterministic registry, not
// one fixed bucket and not full LLM reclustering every run.
//
//   New Observation -> compare against existing Candidate Patterns
//     -> matches one -> add evidence to that pattern
//     -> matches none -> create a new Candidate Pattern
//
// LLM usage is a last resort, not a first step. Observation Intelligence
// (observation-intelligence.ts) owns filtering and confidence scoring
// deterministically; this file's matching logic tries deterministic keyword
// overlap FIRST and only calls the model when that's genuinely ambiguous —
// and only against the small live candidate set, never the full history.
// The one LLM step that has no deterministic substitute is naming/writing
// bullets for a brand-new pattern, which is inherently generative.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.js';
import { computeConfidence, type Confidence } from './observation-intelligence.js';
import { proposeKnowledgeEntry, type KnowledgeEntry } from './knowledge.js';
import { runAgent, parseJsonResponse } from './agent.js';
import type { Observation } from './observations.js';

export const PATTERNS_ROOT = join(REPO_ROOT, 'pattern-registry');

export type PatternStatus = 'candidate' | 'approved' | 'ignored';

export interface PatternOccurrence {
  date: string;
  /** The originating Observation's own stable id (e.g. "tiktok-video-123") — the dedupe key so the same real-world post is never counted twice. */
  observationId: string;
  context: string;
}

export interface CandidatePattern {
  /** This record's own identity — a specific candidate or (future) revision proposal, NOT the playbook itself. Compare playbookId below. */
  id: string;
  /**
   * The playbook's stable identity (e.g. "PLAYBOOK-0007") — survives across
   * revisions, unset until first approval, never reassigned after
   * (M2.7 follow-up: preparing for future Playbook Versioning without
   * building it yet). A future revision-candidate would be created with
   * this already set to the existing target playbook's id, inherited
   * rather than minted — see nextPlaybookId() and approvePattern() below,
   * which already do the right thing either way.
   */
  playbookId?: string;
  name: string;
  /** Set once, at creation, from the founding observation(s) — later matches add occurrences, never rewrite this. See this file's header note on why: reclustering/rewriting on every run is exactly what the founder asked NOT to build. */
  observedPattern: string[];
  status: PatternStatus;
  occurrences: PatternOccurrence[];
  /** Recomputed deterministically (computeConfidence()) every time occurrences change — never asserted by the LLM. */
  confidence: Confidence;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  /** Set on approval — the KnowledgeEntry THIS record resulted in. Renamed from resultingKnowledgeEntryId to pair cleanly with playbookId: this is "which document is live right now," playbookId is "which playbook this document is a revision of." */
  knowledgeEntryId?: string;
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Same constrained frontmatter subset as suggestions.ts/knowledge.ts — see either for why it's hand-rolled rather than a general YAML parser. Duplicated rather than shared, matching this codebase's existing precedent (suggestions.ts and knowledge.ts already each have their own copy at this scale). */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Pattern file is missing a --- frontmatter block: ${raw.slice(0, 80)}...`);
  const [, block] = match;
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
    } else {
      meta[key] = rest;
      i++;
    }
  }

  return { meta, body: '' };
}

function toPattern(meta: Record<string, unknown>, filePath: string): CandidatePattern {
  const confidenceObj = meta.confidence as Record<string, string> | undefined;
  const occurrencesRaw = Array.isArray(meta.occurrences) ? (meta.occurrences as unknown[]) : [];
  return {
    id: String(meta.id ?? ''),
    playbookId: meta.playbookId ? String(meta.playbookId) : undefined,
    name: String(meta.name ?? ''),
    status: (meta.status as PatternStatus) ?? 'candidate',
    observedPattern: Array.isArray(meta.observedPattern) ? (meta.observedPattern as string[]) : [],
    confidence: {
      level: (confidenceObj?.level as Confidence['level']) ?? 'low',
      reason: confidenceObj?.reason ?? '',
    },
    occurrences: occurrencesRaw.map((o) => {
      if (typeof o === 'object' && o !== null) {
        const r = o as Record<string, string>;
        return { date: r.date ?? '', observationId: r.observationId ?? '', context: r.context ?? '' };
      }
      return { date: '', observationId: '', context: String(o) };
    }),
    createdAt: String(meta.createdAt ?? ''),
    updatedAt: String(meta.updatedAt ?? ''),
    reviewedBy: meta.reviewedBy ? String(meta.reviewedBy) : undefined,
    reviewedAt: meta.reviewedAt ? String(meta.reviewedAt) : undefined,
    reviewNotes: meta.reviewNotes ? String(meta.reviewNotes) : undefined,
    knowledgeEntryId: meta.knowledgeEntryId ? String(meta.knowledgeEntryId) : undefined,
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

function serializePattern(p: CandidatePattern): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${p.id}`);
  if (p.playbookId) lines.push(`playbookId: ${p.playbookId}`);
  lines.push(`name: ${p.name}`);
  lines.push(`status: ${p.status}`);
  lines.push('observedPattern:');
  for (const b of p.observedPattern) lines.push(`  - ${b.replace(/\n+/g, ' ').trim()}`);
  lines.push('confidence:');
  lines.push(`  level: ${p.confidence.level}`);
  lines.push(`  reason: ${p.confidence.reason.replace(/\n+/g, ' ').trim()}`);
  if (p.occurrences.length) {
    lines.push('occurrences:');
    for (const o of p.occurrences) {
      lines.push(`  - date: ${o.date} | observationId: ${o.observationId} | context: ${o.context.replace(/\n+/g, ' ').trim()}`);
    }
  } else {
    lines.push('occurrences: []');
  }
  lines.push(`createdAt: ${p.createdAt}`);
  lines.push(`updatedAt: ${p.updatedAt}`);
  if (p.reviewedBy) lines.push(`reviewedBy: ${p.reviewedBy}`);
  if (p.reviewedAt) lines.push(`reviewedAt: ${p.reviewedAt}`);
  if (p.reviewNotes) lines.push(`reviewNotes: ${p.reviewNotes.replace(/\n+/g, ' ').trim()}`);
  if (p.knowledgeEntryId) lines.push(`knowledgeEntryId: ${p.knowledgeEntryId}`);
  lines.push('---', '');
  return lines.join('\n');
}

function walkPatternFiles(): string[] {
  try {
    return readdirSync(PATTERNS_ROOT)
      .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
      .map((name) => join(PATTERNS_ROOT, name))
      .filter((p) => statSync(p).isFile());
  } catch {
    return []; // pattern-registry/ doesn't exist yet — nothing observed so far.
  }
}

export function loadAllPatterns(): CandidatePattern[] {
  return walkPatternFiles().map((filePath) => {
    const raw = readFileSync(filePath, 'utf-8');
    const { meta } = parseFrontmatter(raw);
    return toPattern(meta, filePath);
  });
}

export function listCandidatePatterns(): CandidatePattern[] {
  return loadAllPatterns()
    .filter((p) => p.status === 'candidate')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getPatternById(id: string): CandidatePattern | undefined {
  return loadAllPatterns().find((p) => p.id === id);
}

function writePattern(p: CandidatePattern): void {
  mkdirSync(PATTERNS_ROOT, { recursive: true });
  writeFileSync(p.filePath, serializePattern(p), 'utf-8');
}

// ---------------------------------------------------------------------------
// Deterministic matching — tier 1 (dedupe) and tier 2 (keyword overlap).
// Only when tier 2 is genuinely ambiguous does anything below call the LLM.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'was', 'were', 'are',
  'this', 'that', 'your', 'you', 'it', 'its', 'be', 'as', 'by', 'from', 'has', 'have', 'had', 'will', 'my', 'our',
]);

export function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * Overlap coefficient (intersection / size of the SMALLER set), not Jaccard
 * (intersection / union). A short new-post caption is compared against a
 * longer, more elaborate pattern description — Jaccard's union-normalized
 * score is dominated by the longer side's vocabulary and stays low even for
 * a genuine match, which verification against real-shaped text caught
 * empirically (a clearly-matching caption scored ~0.08 under Jaccard,
 * indistinguishable from a genuinely ambiguous one). Overlap coefficient
 * asks "what fraction of the shorter text's real content is also in the
 * longer one," which is the actual question being asked here.
 */
export function overlapSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

// Tuned against real-shaped examples (see the verification script this was
// checked with), not guessed: a genuinely matching caption scored ~0.15, a
// borderline/ambiguous one ~0.09, and an unrelated one 0. A false "clear
// match" would silently misattribute evidence to the wrong pattern, so the
// margin required between top and second-best candidate is deliberately
// real, not a coin flip.
const CLEAR_MATCH_THRESHOLD = 0.12;
const CLEAR_NOVEL_THRESHOLD = 0.04;
const AMBIGUOUS_MARGIN = 0.05;

export function findDeterministicMatch(observationWords: Set<string>, candidates: CandidatePattern[]): { match: CandidatePattern | null; ambiguous: boolean } {
  const scored = candidates
    .map((c) => ({ c, score: overlapSimilarity(observationWords, wordSet(`${c.name} ${c.observedPattern.join(' ')}`)) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < CLEAR_NOVEL_THRESHOLD) return { match: null, ambiguous: false }; // clearly novel — no LLM needed to know that
  if (top.score >= CLEAR_MATCH_THRESHOLD) {
    const second = scored[1];
    if (!second || top.score - second.score >= AMBIGUOUS_MARGIN) return { match: top.c, ambiguous: false }; // clear match — no LLM needed to confirm
  }
  return { match: null, ambiguous: true }; // genuinely unclear — the one case worth spending a model call on
}

// ---------------------------------------------------------------------------
// LLM steps — bounded, and only reached when deterministic logic above
// couldn't decide (matching) or the task has no deterministic substitute
// at all (naming a brand-new pattern from prose).
// ---------------------------------------------------------------------------

function captionOf(observation: Observation): string {
  return typeof observation.data.video_description === 'string' ? observation.data.video_description : '';
}

interface MatchLlmResponse {
  matchedPatternId: string | null;
}

async function llmMatchAgainstCandidates(observation: Observation, candidates: CandidatePattern[]): Promise<string | null> {
  const candidateList = candidates.map((c) => `- id: ${c.id}\n  name: ${c.name}\n  observed pattern: ${c.observedPattern.join('; ')}`).join('\n');
  const caption = captionOf(observation);

  const userPrompt = [
    'A new post significantly outperformed the recent average. Deterministic keyword matching could not clearly decide whether it repeats one of the small number of patterns already being tracked below, or is something new — this is exactly the kind of close call that needs judgment, not the text-overlap check already tried.',
    '',
    `New post: "${observation.whatHappened}"`,
    caption ? `Caption: "${caption}"` : '',
    `Evidence: ${observation.evidence.join('; ')}`,
    '',
    'Existing candidate patterns:',
    candidateList,
    '',
    "Does the new post genuinely repeat the SAME underlying approach as one of these? Only match if it really does — don't force a match just because both posts did well for unrelated reasons.",
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await runAgent('cmo', { userPrompt, jsonShapeHint: '{"matchedPatternId": string | null}', maxBudgetUsd: 0.03 });
  const parsed = parseJsonResponse<MatchLlmResponse>(raw);
  return parsed.matchedPatternId ?? null;
}

interface CreateLlmResponse {
  name: string;
  observedPattern: string[];
}

async function createPattern(observation: Observation, contradictingCount: number): Promise<CandidatePattern> {
  const caption = captionOf(observation);
  const userPrompt = [
    'A post significantly outperformed the recent average — possibly the start of a repeatable pattern worth naming, so Marketing OS can recognize it again in future posts. This is a single founding observation; the name and bullets below are a hypothesis to test against future evidence, not a settled conclusion.',
    '',
    `Post: "${observation.whatHappened}"`,
    caption ? `Caption: "${caption}"` : '(No caption text available — name and describe based on the title and performance only, and keep bullets minimal rather than inventing detail.)',
    `Evidence: ${observation.evidence.join('; ')}`,
    '',
    'Write:',
    '1. A short, specific pattern name describing the actual approach visible above — not generic, e.g. "Detailed rental listings consistently outperform image-only listings".',
    '2. 3-6 short bullets describing concrete, observable elements that likely contributed — grounded only in what is actually in the caption/title, nothing invented or assumed.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await runAgent('cmo', { userPrompt, jsonShapeHint: '{"name": string, "observedPattern": string[]}', maxBudgetUsd: 0.05 });
  const parsed = parseJsonResponse<CreateLlmResponse>(raw);

  const today = new Date().toISOString().slice(0, 10);
  const id = `pattern-${slugify(parsed.name)}-${Date.now().toString(36).slice(-5)}`;
  const occurrences: PatternOccurrence[] = [{ date: today, observationId: observation.id, context: observation.whatHappened }];
  const pattern: CandidatePattern = {
    id,
    name: parsed.name,
    observedPattern: parsed.observedPattern,
    status: 'candidate',
    occurrences,
    confidence: computeConfidence(occurrences, contradictingCount),
    createdAt: today,
    updatedAt: today,
    filePath: join(PATTERNS_ROOT, `${id}.md`),
  };
  writePattern(pattern);
  return pattern;
}

function appendOccurrence(pattern: CandidatePattern, observation: Observation, contradictingCount: number): void {
  const today = new Date().toISOString().slice(0, 10);
  pattern.occurrences.push({ date: today, observationId: observation.id, context: observation.whatHappened });
  pattern.confidence = computeConfidence(pattern.occurrences, contradictingCount);
  pattern.updatedAt = today;
  writePattern(pattern);
}

/**
 * The entry point, called from collectObservations() (pipeline/services/morning/collect.ts)
 * right after routeObservations(). `executive` supplies the outperforming
 * video_performance observations that can become/reinforce a pattern;
 * `department` supplies this same run's underperforming ones, counted as
 * the (deliberately simple — see this file's header) "contradicting
 * observations" confidence signal. Both are the exact routed arrays
 * routeObservations() already produced — nothing re-derived.
 */
export async function matchExecutiveObservationsToPatterns(executive: Observation[], department: Observation[]): Promise<void> {
  const candidateObservations = executive.filter((o) => o.kind === 'video_performance');
  if (candidateObservations.length === 0) return;

  const contradictingCount = department.filter((o) => o.kind === 'video_performance').length;
  const seenObservationIds = new Set(loadAllPatterns().flatMap((p) => p.occurrences.map((o) => o.observationId)));

  for (const observation of candidateObservations) {
    // A video stays in TikTok's "recent 10" window for many days after
    // posting — without this, the same real-world post would be counted as
    // fresh evidence on every single run it remains in that window.
    if (seenObservationIds.has(observation.id)) continue;

    const observationText = `${observation.whatHappened} ${captionOf(observation)}`;
    const candidates = listCandidatePatterns();

    let matchedId: string | null = null;
    if (candidates.length > 0) {
      const { match, ambiguous } = findDeterministicMatch(wordSet(observationText), candidates);
      if (match) matchedId = match.id;
      else if (ambiguous) matchedId = await llmMatchAgainstCandidates(observation, candidates);
    }

    const matchedPattern = matchedId ? candidates.find((c) => c.id === matchedId) : undefined;
    if (matchedPattern) {
      appendOccurrence(matchedPattern, observation, contradictingCount);
    } else {
      await createPattern(observation, contradictingCount);
    }
    seenObservationIds.add(observation.id);
  }
}

// ---------------------------------------------------------------------------
// Founder Approval — mirrors suggestions.ts's approveSuggestion()/
// rejectSuggestion() exactly, so the "two human checkpoints" precedent
// (is this worth considering, then is it accurate enough to trust) applies
// here too. Approval does NOT bypass the Knowledge Layer: it creates a real
// KnowledgeEntry via proposeKnowledgeEntry(), landing at status: 'draft',
// same review queue as everything else.
// ---------------------------------------------------------------------------

/**
 * Deterministic, no LLM — the next stable playbook identity, derived from
 * real committed data (existing playbookIds already on disk), same
 * discipline as everything else in this file. Only ever called when a
 * pattern being approved doesn't already carry a playbookId of its own
 * (i.e. it's not a future revision-candidate that already knows which
 * existing playbook it's proposing to improve — see approvePattern()).
 */
function nextPlaybookId(): string {
  const existingNumbers = loadAllPatterns()
    .map((p) => p.playbookId)
    .filter((id): id is string => !!id)
    .map((id) => Number(id.replace('PLAYBOOK-', '')))
    .filter((n) => !Number.isNaN(n));
  const next = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  return `PLAYBOOK-${String(next).padStart(4, '0')}`;
}

export function approvePattern(input: { id: string; reviewedBy: string }): { pattern: CandidatePattern; entry: KnowledgeEntry } {
  const pattern = getPatternById(input.id);
  if (!pattern) throw new Error(`No candidate pattern found with id "${input.id}"`);
  if (pattern.status !== 'candidate') throw new Error(`Pattern "${input.id}" is already ${pattern.status} — only candidate patterns can be approved.`);

  // Mint a new stable playbook identity, unless this pattern already
  // carries one (M2.7 follow-up — preparing for future Playbook
  // Versioning: a revision-candidate not built yet would be created with
  // playbookId already pointing at the existing playbook it's proposing to
  // improve, and this line already does the right thing for that case too).
  const playbookId = pattern.playbookId ?? nextPlaybookId();

  const entry = proposeKnowledgeEntry({
    category: 'marketing/playbooks',
    title: pattern.name,
    body: [
      pattern.observedPattern.map((b) => `- ${b}`).join('\n'),
      '',
      `Confidence at approval: ${pattern.confidence.level} — ${pattern.confidence.reason}`,
      '',
      `Supporting evidence: ${pattern.occurrences.map((o) => `${o.context} (${o.date})`).join('; ')}`,
      '',
      `Playbook ID: ${playbookId}`,
    ].join('\n'),
    tags: ['playbook', playbookId],
    source: { type: 'agent-inference', reference: `pattern-registry/${pattern.id}.md` },
    contributedBy: 'observation-intelligence',
    // Confidence level -> a starting numeric score for the new entry, same
    // convention proposeKnowledgeEntry() callers elsewhere already follow —
    // still fully subject to the same draft->verified review, not
    // pre-trusted into skipping it.
    confidence: pattern.confidence.level === 'high' ? 0.85 : pattern.confidence.level === 'medium' ? 0.65 : 0.45,
  });

  const today = new Date().toISOString().slice(0, 10);
  const updated: CandidatePattern = { ...pattern, status: 'approved', playbookId, updatedAt: today, reviewedBy: input.reviewedBy, reviewedAt: today, knowledgeEntryId: entry.id };
  writePattern(updated);
  return { pattern: updated, entry };
}

/** Never deletes the file — an ignored pattern stays as a permanent record, same permanence principle as content-vault/ and rejectSuggestion(). "Disappears" means excluded from listCandidatePatterns(), not erased. */
export function ignorePattern(input: { id: string; reviewedBy: string; reason: string }): CandidatePattern {
  const pattern = getPatternById(input.id);
  if (!pattern) throw new Error(`No candidate pattern found with id "${input.id}"`);
  if (pattern.status !== 'candidate') throw new Error(`Pattern "${input.id}" is already ${pattern.status} — only candidate patterns can be ignored.`);
  if (!input.reason) throw new Error('reason is required when ignoring a pattern.');

  const today = new Date().toISOString().slice(0, 10);
  const updated: CandidatePattern = { ...pattern, status: 'ignored', updatedAt: today, reviewedBy: input.reviewedBy, reviewedAt: today, reviewNotes: input.reason };
  writePattern(updated);
  return updated;
}

/** A genuine no-op decision, not a new status — postpones a decision until more evidence accumulates. The pattern keeps accumulating occurrences exactly as it would have anyway; this only records that a human looked at it today without acting. No snooze/suppression — it reappears next time regardless, deliberately simple for v1. */
export function keepObservingPattern(input: { id: string; reviewedBy: string }): CandidatePattern {
  const pattern = getPatternById(input.id);
  if (!pattern) throw new Error(`No candidate pattern found with id "${input.id}"`);
  if (pattern.status !== 'candidate') throw new Error(`Pattern "${input.id}" is already ${pattern.status}.`);

  const today = new Date().toISOString().slice(0, 10);
  const updated: CandidatePattern = { ...pattern, updatedAt: today, reviewedBy: input.reviewedBy, reviewedAt: today };
  writePattern(updated);
  return updated;
}
