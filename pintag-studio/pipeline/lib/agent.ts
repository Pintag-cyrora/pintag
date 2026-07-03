import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLlmProvider } from './llm.js';
import { REPO_ROOT } from './config.js';
import type { AgentName } from './health.js';

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/**
 * Builds the system prompt every headless agent call shares: brain/ceo.md
 * first (the rule stated in CLAUDE.md — every agent reads this before doing
 * anything else), then the target employee's own job description. The
 * subagent frontmatter (name/description/tools) is stripped — the `tools`
 * list describes what that employee is allowed inside an interactive Claude
 * Code session, which doesn't apply here: headless runAgent() calls get no
 * tool access at all, by design (see pipeline/lib/llm.ts).
 */
function loadAgentSystemPrompt(agentName: AgentName): string {
  const ceoBrief = readFileSync(join(REPO_ROOT, 'brain', 'ceo.md'), 'utf-8');
  const agentSpec = stripFrontmatter(
    readFileSync(join(REPO_ROOT, '.claude', 'agents', `${agentName.replace(/_/g, '-')}.md`), 'utf-8')
  );

  return [
    '# Founder Brief (read first, every run)',
    ceoBrief,
    '',
    `# Your Role: ${agentName}`,
    agentSpec,
    '',
    '# Execution Context',
    'You are being invoked headlessly as one stage of an automated pipeline. You have no tool access in this call — the orchestrating code has already gathered everything you need and included it in the message below. Respond only with the content requested, in exactly the format requested.',
  ].join('\n');
}

export interface RunAgentOptions {
  userPrompt: string;
  /** Human-readable description of the expected JSON shape, if the caller needs structured output. */
  jsonShapeHint?: string;
  maxBudgetUsd?: number;
}

/**
 * The one mechanism every "thinking" stage (Research, Write, Brand Guardian)
 * calls through. Loads the target employee's context, delegates the actual
 * model call to whichever LlmProvider is configured (pipeline/lib/llm.ts),
 * and returns the raw text response — callers own parsing/validation.
 */
export async function runAgent(agentName: AgentName, options: RunAgentOptions): Promise<string> {
  const systemPrompt = loadAgentSystemPrompt(agentName);
  return getLlmProvider().complete({
    systemPrompt,
    userPrompt: options.userPrompt,
    jsonShapeHint: options.jsonShapeHint,
    maxBudgetUsd: options.maxBudgetUsd,
  });
}

/**
 * Parses a runAgent() response that was asked to return JSON. Strips a
 * markdown code fence if the model added one despite instructions not to.
 * Throws with the raw text included so a malformed response is debuggable,
 * not silently swallowed. Callers still validate the parsed shape
 * themselves — this only guarantees "valid JSON," not "the right JSON."
 */
export function parseJsonResponse<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`Agent response was not valid JSON:\n${cleaned.slice(0, 1000)}`);
  }
}
