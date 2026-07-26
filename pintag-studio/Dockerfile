# Deployed Founder Workspace (M2.11) — runs pipeline/founder-server.ts so the
# founder can trigger Marketing OS pipelines from their phone.
#
# This image contains the WHOLE pintag-studio directory, not just pipeline/.
# That's required, not incidental: generation reads brain/*.md,
# knowledge-base/, knowledge/, templates/, and .claude/agents/*.md off disk at
# runtime (see pipeline/lib/agent.ts and services/morning/collect.ts). A
# slimmer image that shipped only compiled code would start and then fail on
# the first generate.
#
# IMPORTANT — LLM provider. The default provider shells out to the `claude`
# CLI, which needs an interactive login that can't happen in a container. A
# deployed instance therefore runs LLM_PROVIDER=anthropic-api with
# ANTHROPIC_API_KEY (pipeline/lib/llm.ts's AnthropicApiProvider). Same
# prompts, same parsing, same validation — but a different provider path, so
# wording can vary slightly from a local `npm run daily-briefing` run. This
# is the one place deployed output is not byte-identical to local output, and
# it's a property of the runtime, not a change to the pipeline.

FROM node:22-slim

WORKDIR /app

# Dependencies first, so a code-only change doesn't reinstall them.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# The knowledge/brain/agent files the pipeline reads at runtime come along
# with everything else here.
COPY . .

# Writable state. daily-briefing.ts writes local artifacts before publishing
# to Supabase; on most container hosts this is ephemeral, which is fine —
# Supabase's morning_briefs row is what the phone reads, and it's the durable
# copy. Mount a volume here if you want the on-disk history to survive
# restarts (see EXECUTION_ARCHITECTURE.md).
RUN mkdir -p daily-briefing dashboard content-vault/campaigns research learning

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MARKETING_OS_REQUIRE_AUTH=true \
    LLM_PROVIDER=anthropic-api

EXPOSE 8080

# Secrets are NOT baked in — set them on the host (fly secrets set / Render
# env vars): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# MARKETING_OS_FOUNDER_EMAIL, MARKETING_OS_ALLOWED_ORIGINS, ANTHROPIC_API_KEY.
# founder-server.ts refuses to start on a non-loopback HOST unless auth is
# properly configured, so a missing secret fails loudly at boot instead of
# quietly exposing an open server.
CMD ["npx", "tsx", "pipeline/founder-server.ts"]
