import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// Minimal LLM provider abstraction — the department must never be coupled to
// one execution mechanism. Every "thinking" stage (Research, Write, Brand
// Guardian) goes through this interface via pipeline/lib/agent.ts; adding a
// new provider (OpenAI, Gemini, a local model) means one more class here and
// an LLM_PROVIDER config value, never a change to any pipeline stage.

export interface LlmCompletionInput {
  systemPrompt: string;
  userPrompt: string;
  /** Human-readable description of the expected JSON shape, injected into the prompt. Not a schema-validation mechanism — callers validate the parsed result themselves. */
  jsonShapeHint?: string;
  maxBudgetUsd?: number;
}

export interface LlmProvider {
  complete(input: LlmCompletionInput): Promise<string>;
}

/**
 * Shells out to the Claude Code CLI in headless mode. Runs from a neutral
 * temp directory (not the repo) so it doesn't auto-discover this project's
 * CLAUDE.md files and inflate every call with unrelated context — all
 * context this provider needs is passed explicitly via systemPrompt/userPrompt.
 *
 * Deliberately does NOT use `--json-schema`: empirically (see M1 build notes)
 * it routes through a tool-use code path that costs roughly 6x a plain
 * prompted response for the same task. Structured output is instead
 * requested in plain language via jsonShapeHint, and the caller
 * (pipeline/lib/agent.ts) is responsible for parsing/validating the result —
 * the same discipline a schema-based approach would require anyway, since
 * the model's own claims about a score are never trusted without the
 * deterministic checks in pipeline/stages/06-guardian-review.ts.
 */
export class ClaudeCliProvider implements LlmProvider {
  async complete(input: LlmCompletionInput): Promise<string> {
    const prompt = input.jsonShapeHint
      ? `${input.userPrompt}\n\nRespond with ONLY valid JSON matching this shape, no markdown code fences, no explanation:\n${input.jsonShapeHint}`
      : input.userPrompt;

    const args = [
      '-p',
      prompt,
      '--append-system-prompt',
      input.systemPrompt,
      '--output-format',
      'json',
      '--max-budget-usd',
      String(input.maxBudgetUsd ?? 0.5),
    ];

    const { stdout } = await execFileAsync('claude', args, {
      cwd: tmpdir(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });

    const envelope = JSON.parse(stdout);
    if (envelope.is_error) {
      throw new Error(`claude -p failed: ${envelope.subtype ?? 'unknown error'} — ${JSON.stringify(envelope.errors ?? [])}`);
    }
    if (typeof envelope.result !== 'string') {
      throw new Error(`claude -p returned no usable result field: ${stdout.slice(0, 500)}`);
    }
    return envelope.result;
  }
}

/**
 * Direct Anthropic Messages API call. Fallback for environments where the
 * Claude Code CLI isn't installed or its auth doesn't reach a headless
 * subprocess (e.g. some CI runners) — see SETUP.md.
 */
export class AnthropicApiProvider implements LlmProvider {
  async complete(input: LlmCompletionInput): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('LLM_PROVIDER=anthropic-api requires ANTHROPIC_API_KEY to be set — see SETUP.md.');
    }

    const prompt = input.jsonShapeHint
      ? `${input.userPrompt}\n\nRespond with ONLY valid JSON matching this shape, no markdown code fences, no explanation:\n${input.jsonShapeHint}`
      : input.userPrompt;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`Anthropic API returned no usable text content: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return text;
  }
}

let cachedProvider: LlmProvider | undefined;

export function getLlmProvider(): LlmProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = process.env.LLM_PROVIDER ?? 'claude-cli';
  switch (providerName) {
    case 'claude-cli':
      cachedProvider = new ClaudeCliProvider();
      break;
    case 'anthropic-api':
      cachedProvider = new AnthropicApiProvider();
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${providerName}" — expected "claude-cli" or "anthropic-api".`);
  }
  return cachedProvider;
}
