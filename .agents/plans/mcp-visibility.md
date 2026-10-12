# MCP / tool visibility — PLAN ONLY (not scheduled for implementation)

Status: design plan from `/root/implementation-architecture`. **No code is to be written from this file until the user schedules it.** Depends on the decision API and backends from `implementation-architecture.md` (§2–3) being implemented.
Evidence: installed Pi 1.1.0 (`$PI=/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent`), `.agents/plans/pi-integration-research.md` §6.

## Goal

Per prompt, use a decision model to decide which MCP servers (and optionally individual MCP tools) are visible to the model, analogous to the skill relevance filter. "Visible" has three distinct levels; the plan treats them separately because Pi exposes different hooks for each:

| Level | Meaning | Hook available in 1.1.0 | Reliability |
|---|---|---|---|
| L1 Declared | tool schema sent to the model (`direct` exposure) | `before_agent_start` → `event.systemPromptOptions.selectedTools`; `pi.setActiveTools` | Good for `direct` tools only |
| L2 Advertised | `mcp_servers` system-prompt section listing `codemode`/`deferred` servers | `event.systemPromptOptions.sections.mcp_servers` | **Built-in MCP rewrites it** every `before_agent_start` (`$PI/dist/extensions/mcp/index.js:1030-1040`); an early extension's edit is overwritten |
| L3 Callable | tool can actually execute (direct, codemode `ALL_TOOLS`/`searchTools`, `tool_search`) | `tool_call` handler `{block:true, reason}`; nested codemode calls carry `parentToolCallId` (`$PI/dist/core/extensions/types.d.ts:908-925,1065-1073`; `$PI/docs/mcp.md` "Permissions") | Strong: every MCP call goes through the tool pipeline |

Not achievable via hooks: hiding entries from codemode `searchTools()`/`ALL_TOOLS`/`describeNamespace()` results and from `tool_search` matching. Those enumerate registered tools regardless of active set (`$PI/docs/mcp.md` "Control tool exposure"; `$PI/docs/codemode.md:20-51`). L3 blocking makes them unusable, not invisible.

## Recommended design (when scheduled)

### Inventory (read-only)
- Source of truth: `pi.getAllTools()` → `ToolInfo` with `name`, `exposure`, `namespace` (`{name:"mcp__<server>", description, instructions}`), `annotations`. Group tools whose namespace starts with `mcp__` by server. **Do not** use `pi.getMcpServers()` (extension-registered servers only, `$PI/dist/core/extensions/types.d.ts:1364-1368`) and do not read `mcp.json`.
- Snapshot per prompt in `before_agent_start`; servers that connect later appear in the next prompt's snapshot.
- Candidate unit = **server** (namespace) by default; per-tool selection optional for servers above N tools. Exclude `hidden` tools. Candidate metadata = namespace name + description (+ first 300 chars of instructions, opt-in) + tool names. Never tool results.

### Decision
- New pure app `src/apps/mcp-relevance.ts` reusing `apps/relevance.ts` machinery with the same score rubric `[irrelevant, related, directly relevant]`; state `{task, servers:{m0:{name, description, tools:[...]}}}`.
- New pure policy `src/apps/mcp-filter.ts` → `{ allowedServers: Set<string>, allowedTools?: Set<string>, reason }` with pinned servers, `minLabel`, fail-open default (all allowed).
- Store the per-turn decision in extension memory keyed by turn; cleared on `session_start`/`agent_end`.

### Application of the decision
1. **L1 (MVP of this plan):** in our `before_agent_start`, remove `mcp__<server>__*` names of non-allowed servers from `event.systemPromptOptions.selectedTools`. Must snapshot the *baseline* active set at first sight per session and compute from baseline each turn, otherwise tools removed last turn vanish from future candidate inventories (research §6). Verify that built-in MCP does not re-add direct tools to `selectedTools` after us.
2. **L3 (opt-in "enforce" setting):** `pi.on("tool_call")` → if `toolName` starts with `mcp__` and server not allowed for the current turn → `{block:true, reason:"pi-context-decisions: server <x> judged irrelevant for this prompt; ask the user or run /context-decisions mcp allow <x>"}`. Applies to nested codemode calls too. Default **off** because a misclassification blocks legitimate work; when on, user-pinned servers bypass. Resource tools (`list_mcp_resources`, `read_mcp_resource`) carry a `server` argument; block by that argument value.
3. **L2:** two candidate approaches, both require verification before choosing:
   - (a) **Late handler**: register a second `before_agent_start` handler that runs *after* built-in MCP and filters `sections.mcp_servers` text by server. Blocked on an open question: where built-in extensions sit in handler order relative to user extensions (`$PI/dist/core/extensions/runner.js:1121-1165` runs in load order; built-in load position not verified). If built-ins load first, our handler naturally runs after and (a) is viable. Section text is rendered by `renderServersSection`; filtering requires parsing its format — brittle, pin to Pi version and test against fixture.
   - (b) **`context_with_system` event** (`$PI/dist/core/extensions/types.d.ts:660-676`): handler owns full prompt + tool declarations per LLM call; could drop server lines and direct declarations. Highest power, highest risk (prompt-cache invalidation, conflicts with every other extension, must not alter anything else). Not recommended unless (a) fails.
   - Preferred long-term: **upstream Pi API** — ask for an MCP server-visibility filter hook (e.g. `mcp_servers_section` event or per-turn server enable mask). Track as an external request.

### Explicitly rejected
- Replacing built-in MCP (registering `/mcp`) — disables `mcp.json` handling entirely (`$PI/docs/mcp.md` "Replace the built-in MCP support"); scope explosion.
- Re-registering MCP tools as `hidden` — tools cannot be unregistered and we do not own MCP tool registrations.
- Toggling server `enabled` per prompt — disconnect/reconnect churn, session-wide side effects.
- Claiming L1/L2 filtering as a security boundary — codemode/tool_search still reach non-declared tools; only L3 blocks.

## Phased steps (for a future scheduling)

| Phase | Deliverable | Depends | Acceptance |
|---|---|---|---|
| M0 | Spike: verify built-in vs user `before_agent_start` order; confirm built-in MCP doesn't touch `selectedTools`; capture `mcp_servers` section fixture | — | Written findings appended here with file:line evidence |
| M1 | `getAllTools()` inventory grouping (pure `groupMcpTools(tools)`) | M0 | Tests: grouping by `mcp__` namespace, hidden excluded, non-MCP ignored, server names with `-`/`_` |
| M2 | `mcp-relevance.ts` + `mcp-filter.ts` | decision API, relevance app | Same test matrix as skill relevance; fail-open; pinned |
| M3 | L1 selectedTools filtering with baseline snapshot | M1, M2 | Wiring test: only MCP direct names removed; non-MCP tools untouched; baseline restored next turn; no call when no MCP servers |
| M4 | L3 opt-in `tool_call` block incl nested `parentToolCallId` and resource tools | M2 | Tests: blocked/allowed/pinned/enforce-off; reason text; codemode nested call blocked |
| M5 | L2 section filtering via approach (a) if M0 proves ordering | M0, M2 | Fixture test on section format; no-op if format unrecognised (fail-open) |
| M6 | `/context-decisions mcp` status/allow/pin + README limitations | M3–M4 | Docs state visibility vs enforcement precisely |

## Risks / open questions
- Built-in extension load order (decides L2 approach) — unverified.
- Latency: an additional decision call per prompt; batch servers + skills into one request (shared `state.task`, distinct question ids) to keep one round-trip.
- Misclassification under enforce mode blocks needed tools mid-task; per-turn decisions may flip between turns of the same task — consider sticky allow within a session.
- MCP server descriptions/instructions are third-party text: treat as untrusted data inside `state`, never instructions.
