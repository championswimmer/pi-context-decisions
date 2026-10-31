[README](../README.md) · [Documentation](README.md)

# Development

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Offline tests include provider fixtures, credential precedence/OAuth, malformed responses, deadlines, batching, real extension registration mocks, picker/headless commands, persistence, and the additive ledger lifecycle. Both simulated sessions and real Pi `AgentSession` tests run offline with injected decision clients and a faux provider; they cover branches, compaction, context edits, queued messages and tool rounds, not live inference. Live TypeSafe/OpenRouter and direct Luna primitive checks passed on 2026-10-12; a terminal visual check has not been performed. Explicitly opt into billable public-fact checks (never part of `npm test`):

```bash
# Only Luna; Pi's saved openai API key works without an env key.
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts gpt-6-luna
# Only TypeSafe (or pass a retained OpenRouter ID).
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts jev-latest
```

The smoke script resolves Pi credentials first, then env; it never substitutes `openai-codex`. `openai` and `luna` are aliases for the explicit Luna target. With no model arguments it checks TypeSafe plus the retained router list, **not Luna**. Without the opt-in it exits before SDK initialization or network activity. It prints safe source-kind/presence booleans/status/scalars/usage, never credentials or raw provider error bodies. Settings use Pi's built-in dialogs/status APIs, including RPC support; the custom allowlist overlay is terminal-only.

Native Pi inference remains unverified. See [provider validation](providers.md#static-openrouter-snapshot), [contributor instructions](../AGENTS.md), and [release procedures](publishing.md).
