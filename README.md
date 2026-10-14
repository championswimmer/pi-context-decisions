# pi-context-decisions

A [Pi](https://pi.dev) extension that uses decision/classifier models to decide which **additional skills to advertise** as a session goes on. Skill picking is **score-only and additive**: relevant skills are added, nothing is ever dropped. Core adapters, the unified decision API, model picker, settings, and skill relevance picking are implemented. **Tool and MCP filtering is available as a separate opt-in feature (off by default)**: see [Tool & MCP filtering](#tool--mcp-filtering-opt-in). It hides and blocks through Pi's public APIs and is not a sandbox.

Requires Pi 1.1.0 APIs and Node 22.18+. Pre-alpha; TypeSafe, the eight retained OpenRouter models, and direct OpenAI Luna passed live `bool`/`choice`/`score` primitive checks on 2026-10-12 (before skill picking became score-only; the additive picker has only offline tests). Luna used Pi's saved `openai` API key with `OPENAI_API_KEY` absent. Native Pi inference remains unverified.

## Load early

```bash
pi install npm:pi-context-decisions
# or, from a checkout
npm install
pi -e ./src/extension.ts -e ./other-extension.ts
```

Keep this extension first or near the start of your configured extensions/packages. Pi awaits handlers in load order. In `before_agent_start` we set `systemPromptOptions.skills` to a **stable base** (always-allowed skills, or the whole inventory once filtering was off on this branch) and return new skills as a hidden custom message; later handlers see that base array and can overwrite it. There is no extension-priority guarantee.

### How skills are added (additive picking)

Every picking round scores **only skills that have not been advertised on this session branch yet**, keeps up to *max added per round* of those at or above the threshold, and **adds** them. Skills already added are never re-scored, and nothing is removed later: not by a lower threshold, a settings change, an allowlist change, a failed round or a model switch.

- **Delivery.** New skills are appended as an **append-only custom message** (`context-decisions-skills`, hidden from the transcript) built with Pi's public `formatSkillsForPrompt`, so the chat model sees Pi's own `<available_skills>` block (name, description and file location) for just the new skills, introduced by one line saying previously listed skills remain available. Locations are needed by the chat model to load a skill; they are **never** sent to the decision model. Pi converts custom messages to **user-role** context. That is not a native system-prompt update: Anthropic's and OpenAI's mid-conversation *system* messages only exist on selected models, and rewriting the system skills section would invalidate the cached prompt prefix on the others. Appended messages work on every provider and keep earlier prompt-cache prefixes intact. OpenAI's own Skills feature likewise places skill metadata in user-priority context.
- **Stable base.** Always-allowed skills (global/project allowlists and legacy pins) are the only skills in `systemPromptOptions.skills`, identical on every prompt, so Pi emits no prompt-section patch. If filtering is disabled, no model is configured or the inventory is below *Minimum inventory*, **every** skill stays advertised, and the branch remembers it: enabling filtering later never removes a skill the model already saw.
- **Per-branch ledger.** What was advertised is derived from the active session branch (base records plus the delta messages Pi actually persisted), so new sessions start empty, forks inherit, `/tree` navigation follows the active branch and `/resume` or `/reload` rebuild it. A model switch changes nothing.
- **Compaction.** Compaction can summarize a delta message away. Skills whose text is no longer in model-visible context are **re-delivered** (names and descriptions only, no decision call, never re-scored) at the next prompt, or at the next `turn_end` if compaction happened inside a run. Known limitations: the request issued immediately after a mid-run compaction, including overflow recovery's retry, can lack those skills until then; a skill deleted by `/reload` stays mentioned in older messages; with neither `read` nor `bash` active nothing can be delivered, so nothing is scored or recorded.
- **When it runs.** *Run picker* **prompt** (default): on every submitted prompt, plus steering/follow-up user text queued during a run (seen at `turn_end`). **tool-round** (opt-in): also after each completed tool round (`turn_end` with tool results; assistant-only turns and aborted or failed turns never trigger it). Tool-round picking is **progressive addition for the same task, not subtask inference**: the decision model still receives only the latest bounded user text plus candidate names/descriptions, never assistant text, tool names, arguments or results. Because *max added per round* caps each round, the next round adds the next-best remaining skills; scores for the same task are cached, so it makes no extra decision call. Neither cadence ever sets `continue`, so the extension never creates an extra model request.
- **Pi cannot** change the system prompt's skills between tool rounds through a public API, and the extension does not rewrite provider payloads or use `context`/`context_with_system`; that is why deltas are custom messages.

For a local package install, `pi install /absolute/path/to/pi-context-decisions` is supported; ensure package ordering remains appropriate. The package ships TypeScript sources that Pi loads directly; it requires Node >= 22.18 and the Pi peer packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`).

## User settings: `/decisions`

Run **`/decisions`** to open the settings. In Pi's terminal UI this is a **floating dialog** drawn over the session, not a block in the status area: the session underneath keeps printing and scrolling while the dialog stays where it is. The dialog has two peer tabs, **Skill picker** and **Tool picker**, switched with **Tab**/**Shift+Tab** or **←/→**; the tab strip is the first line of the dialog. The **Skill picker** tab is deliberately short:

| Row | What it does |
|---|---|
| **Context decisions** · On/Off | Immediately enables or disables skill filtering (Space or Enter). |
| **Provider / execution** | Pi's classifier pipeline or a direct TypeSafe, OpenAI or OpenRouter endpoint. |
| **Model** | The decision model. Providers without a key are labelled **missing key**. |
| **Always allowed · Global / Project** | The searchable allowlist editors (see below). |
| **Advanced…** | Every relevance fine-tuning knob (see below). |
| **Status…** | Credentials source, last decision and allowlist counts. Makes no inference calls. |
| **Close** | Closes the dialog. |

**Advanced…** lists, in order: **Skill filtering** on/off; **Relevance threshold** (0–1, inclusive; default 0.375); **Shard size** (skills per decision request, 1–50); **Max added per round** (new skills per picking round, ranked across all shards; always-allowed and already-added skills do not count); **Run picker** (`prompt` or `tool-round`); then the safety limits **On failure**, **Timeout**, **Concurrency**, **Minimum inventory** and the **prompt/description size** limits. Selecting a row edits it inline with validation (the same rules as `/decisions relevance <key> <value>`); **Run picker** and **On failure** are option lists where `open` carries a visible warning and is never reached by cycling. Legacy `pin`/`unpin` names stay on the text commands.

The **Tool picker** tab is the opt-in tool/MCP filtering ([Tool & MCP filtering](#tool--mcp-filtering-opt-in)): its own on/off, mode, picker cadence, limits and the four always-allowed editors, directly on the tab rather than behind a nested screen. It shares the decision provider/model chosen on the Skill picker tab. This is the extension's only command; headless use supports the same actions through arguments.

Dialog keys: **↑/↓/PgUp/PgDn** move, **Enter** selects, **Space** toggles on/off rows, **Tab**/**Shift+Tab**/**←/→** switch tabs (only on a tab, not inside an editor or sub-screen), **Esc** goes back (and closes from either tab). While the dialog has focus, **Esc and Ctrl+C act on the dialog, not on the running agent**: close it to interrupt or type a prompt. Running `/decisions` again while it is open focuses the existing dialog instead of opening a second one. Reloading or shutting down the session closes the dialog and cancels its in-flight work. RPC clients cannot show tabs, so they get the same grouping as select menus (Advanced and Tools & MCP are sub-menus) through select/input requests; print/JSON use the text commands.

**No backend is selected by default**, so startup and prompts make no decision calls until you configure one. Selection persists across sessions and opts in to sending bounded task/skill metadata on eligible prompts. Choosing a provider/model does not change the enabled toggle. Providers and models are labelled **configured** or **missing key**; unavailable selections are rejected without changing settings. Configure the relevant `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` in the environment, or use `/login <provider>` in Pi. Credentials remain Pi-first/environment-second; OpenAI requires its API key, not Codex/ChatGPT OAuth.

```text
/decisions                                    # floating settings dialog; status headless
/decisions provider                           # provider/path picker; availability headless
/decisions model                              # opens the dialog on the model screen (TUI); select menu (RPC)
/decisions provider openai                     # direct Luna with available API key
/decisions model pi typesafe jev-latest         # Pi internal classifier
/decisions model typesafe jev-1.13.0            # direct TypeSafe
/decisions model openai gpt-6-luna              # direct OpenAI
/decisions model openrouter typesafe/jev-1.13
/decisions model none                          # stop decision calls
/decisions status
```

Native Pi classifiers are listed independently of the chat model; Pi's `/model` excludes classifiers. The picker preserves all non-OpenRouter native classifiers. For OpenRouter, **only the checked-in eight surviving models** are allowed in the picker and settings. A “via Pi” entry appears only if the exact classifier is registered; direct entries are always offered, annotated with credential availability. We do not replace Pi's OpenRouter provider or its chat/image models. Missing native models are a configuration error, not an automatic switch to a paid direct backend.

### Static OpenRouter snapshot

Verified **2026-10-12 UTC**, ranked by prompt + completion tokens during **2026-10-05 through 2026-10-11**:

1. `typesafe/jev-1.13`
2. `perplexity/pplx-decider-v1.1-27b`
3. `cloudflare/clef-flash` (original rank 4)
4. `liquid/d1` (original rank 6)
5. `cloudflare/clef` (original rank 7)
6. `nace-ai/drex-v1.5` (original rank 8)
7. `microsoft/microsoft-decision-1` (original rank 9)
8. `upstage/solar-decide` (original rank 10)

The original top ten was trimmed after live validation: `openai/gpt-6-luna-decisions` and `inception/mercury-decide:free` each returned HTTP 404 with guardrail restrictions twice for this account. They are excluded from both native and direct picker/settings choices; no lower-ranked models were added. These are account-specific routing observations, not claims of global model unavailability. See the [live validation report](.agents/research/live-provider-validation-2026-10-12.md).

Source: [OpenRouter rankings](https://openrouter.ai/rankings), catalog joined with an **unofficial frontend ranking endpoint**, CC BY 4.0. Exact counts and provenance are in `src/catalog/openrouter-models.ts`. This is a dated popularity snapshot of public routed traffic, not model quality or a live availability guarantee. **No runtime popularity-ranking, model-discovery, or catalog-cache requests occur.** Update the list via a reviewed code change; persisted models outside the current list produce an explicit settings error.

## Credentials and backends

| Backend | Operation | Credentials |
|---|---|---|
| Pi | `ctx.modelRegistry.classify()` | Pi request-time authentication |
| TypeSafe direct | `https://api.typesafe.ai/v1/systemone` | Pi-resolved `typesafe` first, then `TYPESAFE_API_KEY` |
| OpenAI direct | `https://api.openai.com/v1/decisions` | Pi-resolved `openai` API key first, then `OPENAI_API_KEY` |
| OpenRouter direct | `https://openrouter.ai/api/alpha/decisions` | Pi-resolved `openrouter` first, then `OPENROUTER_API_KEY` |

All three direct backends use Pi's public request-time `getProviderAuth(provider)` first, then the named env variable when Pi resolution is missing, fails, or is incompatible. Pi resolution itself includes runtime overrides, saved credentials, configured `models.json` API keys, and environment fallback. Saved credentials normally live in `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` overrides the directory. The extension never reads credential files directly and delegates config references/secret commands to Pi. Keys are never stored in extension settings, logged, or returned by status. Direct endpoints are fixed HTTPS destinations, with bounded requests, retries, timeout, cancellation, and validated responses.

**OpenAI ChatGPT OAuth cannot call Decisions.** Resolve the exact `openai` provider API key, never `openai-codex` or the current chat provider. Direct mode rejects request-time OAuth auth even if Pi's cached snapshot is empty, and can fall back to `OPENAI_API_KEY`; native Pi may hide the classifier while OAuth login is active. OpenRouter's own OAuth can resolve an API-compatible key and is not rejected by this OpenAI-specific rule. OpenAI Decisions is beta; OpenRouter Decisions is alpha.

Pi's OpenRouter System One parser is stricter than the direct alpha parser; some model responses may fail “via Pi” when metadata is omitted. Use the explicitly selected direct option as a workaround. Pi cost metadata, when present, is a catalog estimate, not a provider bill.

## Settings and relevance policy

```text
/decisions settings                           # dialog (TUI); menu (RPC); JSON summary headless
/decisions relevance                          # opens Advanced directly (TUI/RPC)
/decisions settings enabled false
/decisions enable
/decisions disable
/decisions relevance threshold 0.375          # normalized 0–1, inclusive (default 0.375)
/decisions relevance chunkSize 50              # shard size: skills per decision request, 1–50
/decisions relevance maxSkills 12              # most NEW skills added per picking round
/decisions relevance cadence prompt            # or tool-round: also after completed tool rounds
/decisions relevance minCandidates 8
/decisions relevance concurrency 0            # all shards parallel (default)
/decisions relevance concurrency 2            # optional concurrent-shard cap, 1–32
/decisions relevance timeoutMs 8000
/decisions relevance failMode open             # explicit: add every remaining skill when scoring fails
/decisions pin typescript
/decisions unpin typescript
/decisions test                                # explicit synthetic bool call; may incur cost
```

Settings live in `<Pi agent dir>/pi-context-decisions/settings.json`, atomically written with mode `0600`. Defaults:

- Relevance enabled, **score-only**; skips fewer than **8 unique automatic skills** (everything stays advertised) and empty prompts (no picks).
- Score rubric: **irrelevant → related → directly relevant** (indices 0–2). A skill's score is an expected rubric index, not a class probability or confidence; normalized score = score/2. The single **threshold** is that normalized score in [0, 1], inclusive: a skill qualifies when its 0–2 score is at least `2 × threshold`. The default **0.375** equals the previous raw 0.75 ("related"). There is no choice mode, minimum label or second threshold: the decision `choice` primitive still exists in the library, but skill picking does not use it.
- Add up to **12 new** skills per round (*max added per round*, best first across all shards); pinned and scoped always-allowed names bypass scoring/cap/threshold. There is no session-total cap. Original skill references are preserved. Manual-only skills are not sent for classification.
- **Fail closed**: a failed round adds nothing; already-advertised skills stay. `failMode open` explicitly adds every remaining candidate once; status labels that fallback.
- **Upgrading:** old settings files load unchanged. `threshold` becomes `relatedThreshold / 2`, or `directThreshold / 2` when `minLabel` was `directly_relevant` (exact; no warning). `mode: "choice"` migrates the same way with one warning. An explicit `threshold` wins over legacy keys with a warning. Invalid legacy values stay settings errors and fail closed. Loading never rewrites the file; the next save writes only the new keys.
- Whole round deadline **8000ms**, requested shards of **50 skills**. Concurrency **0** means every shard starts in parallel: 300 candidates use six shards; 400 use eight. Set concurrency 1–32 to limit simultaneous shards. A lower declared provider/client question limit reduces effective shard size, without omitting candidates.
- Configurable prompt ≤4000 characters and each description ≤400; names ≤64, JSON state ≤65536 characters per batch, inventory ≤1000 unique candidates. These are local safety bounds, not provider token-limit guarantees.

Invalid persisted settings are reported explicitly and advertisements fail closed until repaired with commands or a file edit + `/reload`. Unknown read fields are ignored with a warning; writes reject unknown fields and credentials. Failed writes do not change the active configuration.

### Global and project skill allowlists

From `/decisions`, select **Always allowed · Global** or **Always allowed · Project**; the editor opens inside the same dialog and Esc returns to the Skill picker tab. Like the reference extension's **Always allowed** lists, these are **always-included skill advertisements, not restriction/permission lists**. Matching entries bypass relevance scoring, thresholds, and the per-round cap, join the stable base (so removing an entry never withdraws a skill already advertised on the branch) and remain advertised on fail-closed decision/configuration errors. A global entry matches only user/temporary/global skills; a project entry matches only project-scoped skills. Legacy `pin` names still apply across scopes. Manual-only skills remain unchanged.

- **Global** names are stored as `globalAllowlist` in the user settings file.
- **Project** names are stored in `<cwd>/.pi/pi-context-decisions.json` as `{ "alwaysAllowed": ["skill-name"] }`. It can be shared in the repository; this is scoped to Pi's working directory, so starting in different subdirectories uses different lists. A malformed project list is warned about and treated as empty, not a full-inventory fallback.
- Lists store names only, sorted and deduplicated. Saved names for unloaded skills appear as **(not loaded)** and survive saves unless explicitly removed.

The editor starts in **A-Z**, with immediate local fuzzy search across names and descriptions. **Typing and changing tabs never make decision calls.** Press **Ctrl+R** (or Enter from the search box) for **Relevance** ranking of all loaded skills in the chosen scope against the search term. This explicitly uses the same selected decision backend and 50-skill parallel batches, and may incur charges—even when automatic filtering is disabled. Only search text and skill names/descriptions are sent. Empty searches and missing models/credentials make no call; inline guidance leaves local fuzzy search usable. Query changes mark old results stale; restarting/closing cancels in-flight work.

Keys: **↓** enter list, **↑/↓** navigate, **Space** toggle, **Enter** expand description, **Tab** switch A-Z/Relevance, **Ctrl+K** clear search, **Ctrl+S** save in place. **Esc** returns to search; Esc again closes and discards unsaved changes. Selection changes do not save automatically, and ranking never changes selections. The picker uses Pi's terminal UI; RPC/headless clients can use text commands:

```text
/decisions allowlist global                    # terminal editor
/decisions allowlist project
/decisions allow global list
/decisions allow global add typescript
/decisions allow global remove typescript
/decisions allow project add database-migrations
/decisions allow project clear
```

Before the first prompt the editor uses Pi's loaded skill commands. Afterward it uses an in-memory, metadata-only pre-filter inventory snapshot; after `/reload`, a fresh prompt updates it. Project skills still follow Pi project trust. These lists change advertisements only; explicit skill invocation, tools, and MCP access are unchanged.

### Privacy and scope

Each eligible prompt sends **bounded prompt text plus skill names/descriptions** to the selected endpoint. Untrusted task/metadata stays in state, not classifier instructions. No skill bodies, file paths, images, transcripts, or tool results are sent. (Tool/MCP filtering has its own payload, below.) Nothing is retained per turn beyond the latest bounded diagnostic summary (latency, counts, safe error code, optional usage).

This changes **advertisements, not permissions**: explicit `/skill:name`, reading skill files, and already loaded instructions remain possible. Skill filtering never touches tools or MCP servers; that is the separate opt-in feature below. Cancellation/shutdown aborts in-flight filtering; subsequent prompts use Pi's fresh supplied inventory.

## Tool & MCP filtering (opt-in)

**Off by default and independent of skill filtering.** It has its own switch (`/decisions tools on`, or the **Tool picker** tab in the dialog); only the master `enabled` switch, the selected decision model and the shared scoring limits (timeout, shard size, concurrency, prompt size) are common. Turning it on never selects a model (without one, every tool simply stays available), and selecting a model never turns it on. While it is off the extension never calls `getAllTools`/`setActiveTools`, writes no entries and lets every call through.

**Modes** (`tools.mode`):

- `tools` (default): every **external** tool is its own candidate, regardless of which extension or MCP server provides it.
- `mcp`: each **MCP server** is switched on or off as a whole; other extension tools are never filtered. Servers are identified only by Pi's public namespace (`mcp__<server>`, `-` folded to `_`), never by parsing tool names, reading `mcp.json` or guessing an npm package. Third-party MCP adapters that do not set an `mcp__` namespace are not grouped and count as ordinary extension tools. Allowlisting a single tool of a server in this mode **promotes the whole server**, so a server is never half-on.

**Internal tools are always allowed**: Pi's built-in tools and built-in extensions (`read`, `bash`, `codemode`, `tool_search`, the MCP resource tools, ...) are recognised by Pi-assigned provenance (`builtin:` source), **never by name**. An extension that registers a tool called `read`, an SDK host tool, or a tool with unknown provenance is external and can be filtered; allowlist it if needed. Built-in MCP provenance does not make server tools internal.

**Picker cadence** (`tools.cadence`):

- `initial`: one pick, from your **first user prompt** after filtering became active on the branch (custom-message runs never supply it; a failed pick is retried at the next prompt). Tools or servers that appear later are scored against that first prompt only, never re-picking what was already considered, also after `/reload`.
- `prompt` (default): on each new user prompt, including queued steering/follow-up text.
- `tool-round`: also after completed tool rounds, adding the next-best candidates from cached scores for the same task (no extra call).

With no decision model selected, or fewer candidates than *Minimum candidates*, nothing is scored at ANY boundary and late arrivals stay available (and are recorded). Turning filtering off mid-run restores the tools it withheld at the next continuing boundary. Ledger records are split into chunks of at most 1000 names per list, so large inventories lose nothing.

Candidates that register later (an MCP server connecting late, a new tool) are scored when first met, at the next boundary or lazily when called, and **availability is additive per branch**: once a tool or server is available on a branch it stays available; later rounds only add. Removing an allowlist entry never takes availability away. State lives in non-context `context-decisions-tools` entries derived from the active branch, so `/tree`, fork, resume and `/reload` follow it.

**Allowlists** (both modes, global in `settings.json`, project in `<cwd>/.pi/pi-context-decisions.json` as `alwaysAllowedTools`/`alwaysAllowedMcpServers`; the file still always contains `alwaysAllowed` for older readers): always-available tools and always-available MCP servers, never scored. Scope means where the list applies, not where a tool came from (that is not observable). Tool names are 1-128 characters without whitespace; server names are `[A-Za-z0-9_-]{1,64}` (`dev-radius` and `dev_radius` are the same server). An entry that starts with `mcp__` is **exclusively a canonical namespace key** (`mcp__prod` is the server `prod`); a raw server literally named `mcp__prod` has the namespace `mcp__mcp__prod` and must be allowlisted by that key.

```text
/decisions tools                          # dialog (TUI), settings menu (RPC), status (headless)
/decisions tools on|off
/decisions tools mode tools|mcp
/decisions tools cadence initial|prompt|tool-round
/decisions tools threshold|maxAdded|minCandidates|failMode|maxDescriptionChars <value>
/decisions tools list                     # local names-only inventory and availability
/decisions tools allow <global|project> list|add <tool...>|remove <tool...>|clear
/decisions mcp list
/decisions mcp allow <global|project> list|add <server...>|remove <server...>|clear
```

**How it works**, using only public Pi APIs: undecided *declared* tools (direct/model-only) are removed from Pi's active set with `pi.setActiveTools` before the request (only ever removing tools this extension decided against, and restoring only tools it removed); `selectedTools`, `context_with_system` and provider payloads are never touched. Codemode/deferred tools stay callable and discoverable in Pi whether or not they are active, so **every call is also gated in `tool_call`**, including calls nested in codemode scripts; a blocked call returns a short reason naming the allowlist command. A tool nobody has scored yet is scored once (shared by parallel calls) before the verdict. A hidden names-only notice tells the model which *indirect* (codemode/tool-search) MCP servers and tools are available, and says that directly declared, built-in and unfiltered extension tools are unaffected. The MCP resource tools stay internal (always declared) but are **routed by their `server` argument**: reading a server that is not available is blocked, and **listing resources without naming a server is always blocked while filtering is on**, because the complete server inventory (resource-only and disconnected servers) cannot be verified. A server that exposes only resources is unobservable and must be allowlisted; an allowlisted server is also recorded by canonical key on the branch, so removing the entry later never revokes access that was already available.

**Privacy.** The decision model receives the latest bounded user text plus, in `tools` mode, tool names, bounded descriptions and the MCP server label, or in `mcp` mode the namespace key, server label, namespace description and bounded tool names. Never parameter schemas, annotations, namespace instructions, provenance paths, server configs, arguments, results, assistant text or transcripts. Names and descriptions are third-party data and are sent as data, not instructions. Diagnostics carry counts and safe codes.

**Limits, stated plainly.**

- **Not a sandbox.** `bash`, other processes, the `mcp_servers` prompt section, codemode `searchTools`/`ALL_TOOLS`, `tool_search` results and the connections of MCP servers are unaffected: Pi has no public hook to filter discovery or disable file-configured servers. Filtering is relevance gating through Pi's tool pipeline.
- **First-prompt gap.** Direct-exposure MCP tools that finish connecting during Pi's startup wait can be declared for the first request; calls to them are still gated and the next boundary withholds them.
- **Enabling mid-session** keeps every tool already registered on that branch available (the model may have seen them); filtering then affects tools registered later and new sessions.
- **Ownership.** If another extension, `tool_search` or `--tools` re-activates a filtered tool it is removed again at the next boundary and calls are blocked meanwhile; allowlist it to resolve the conflict. An explicit `selectedTools` edit by another extension wins for that run.
- **Unreadable registry or branch.** If Pi's tool registry cannot be read at call time, the gate falls back to the last provenance-classified snapshot: verified internal tools pass, known external tools follow the ledger and allowlists, anything unknown is blocked, and with no snapshot every call is blocked until the registry recovers (fail closed). A throwing project-allowlist read keeps the last good cache, else only the global lists apply. If the session branch cannot be read the gate still fails closed (allowlisted names and internal tools pass) and no boundary writes, grants or reconciles anything.
- **Superseded rounds.** A round overtaken by a settings or allowlist save, a disable, a mode change or a branch change commits and reconciles nothing; a run that is merely cancelled reconciles only from what the branch already committed.
- **Unreadable settings** never silently drop filtering a branch already has: it keeps enforcing its ledger and adds nothing.
- **Fail closed.** A failed or cancelled round adds nothing; `failMode: open` adds the remaining candidates but never for configuration errors or cancellation.
- **SDK embedders.** Codemode, `tool_search` or MCP added as plain extension factories get `<inline:...>` provenance and are therefore treated as external (and filtered); register them as built-in extensions (`{ builtin: true }`) or allowlist them (`/decisions tools allow global add codemode`).
- **Server labels.** Pi's public namespace has no original-name alias, so a server `dev-radius` is labelled `dev_radius` in reasons and lists; allowlisting accepts either spelling.
- **Handler order.** Pi runs file/package extensions before its built-in MCP/codemode extensions; an SDK-inline instance runs after them. `turn_start` cannot close the first-prompt gap because the first request's declarations are fixed before it.
- **Not covered by compaction re-delivery.** The availability notice is not re-delivered if compaction summarizes it away (calls stay gated).

## Application/core API

Provider names `noul` (TypeSafe/OpenRouter), `predicate` (OpenAI), and Pi's `bool` are normalized to **one internal primitive: `bool`**, alongside `choice` and `score`. Bool answers contain P(true), not a coerced Boolean. Required scalar answers are validated; optional confidence/distributions/legend remain optional.

```typescript
import { createBackend, createDecisionClient } from "pi-context-decisions";

const decisions = createDecisionClient(createBackend(
  { backend: "typesafe", model: "jev-latest" },
  { registry: ctx.modelRegistry },
));
const { answer } = await decisions.bool(
  { task: "Review validation changes" },
  { instructions: "Does this task involve code review?" },
  { timeoutMs: 8000, signal: ctx.signal },
);
// answer.probability is in [0, 1].
```

`choice`, `score`, named-question `decide`, and bounded `decideChunked` share the same contract. State is a JSON object; instructions and rubric criteria intentionally use a string-only, text/JSON subset. Errors reject with typed codes; applications choose fallback policy. The static router allowlist is enforced by extension configuration/picker; low-level backend constructors remain reusable independently.

Standalone hosts can opt into Pi's local SDK credential resolution without loading a session:

```typescript
import { createPiCredentialRegistry } from "pi-context-decisions/pi-credentials";
const registry = await createPiCredentialRegistry();
const luna = createDecisionClient(createBackend({ backend: "openai" }, { registry }));
```

This host-only adapter uses public `ModelRuntime`/`ModelRegistry`, respects Pi's normal agent-directory paths, and does not refresh model catalogs over the network. Active extensions must instead pass `ctx.modelRegistry` to retain in-process credentials/provider overrides. The portable main export has no Pi runtime dependency.

### Reusable skill picker

`pickSkills` works with any of the four core backends through the same decision client. It is a **stateless, score-only** helper: it evaluates **every** unique automatic candidate in bounded batches, ranks by expected relevance, applies threshold/cap/pins, and returns the original skill objects in inventory order. The extension builds its additive, branch-aware behavior on the same ranking and selection primitives (`scoreAdditions`, `RelevanceScoreCache`) but keeps a ledger; `pickSkills` does not. Names and descriptions are the only skill information transmitted; file paths are retained locally for Pi's selected advertisements. It does not read or attach full skill bodies.

```typescript
import { createBackend, createDecisionClient, pickSkills } from "pi-context-decisions";

const client = createDecisionClient(createBackend(selection, {
  registry: ctx.modelRegistry,
  getRegistry: () => ctx.modelRegistry, // required when selection.backend is "pi"
}));
const picked = await pickSkills(prompt, thirtySkills, client, {
  chunkSize: 50, maxQuestions: 50, concurrency: 0, // all scoring batches in parallel
  threshold: 0.625,            // normalized 0–1, inclusive (raw expected index >= 1.25)
  maxSkills: 6, timeoutMs: 8000,
});
// picked.items: scored (non-pinned) candidate scores; picked.kept: selected original objects.
// An explicit picker has minCandidates: 0 by default; the extension's automatic path defaults to 8.
// Passing the removed mode/minLabel/relatedThreshold/directThreshold options is a config error (fails closed).
```

Passing `null` as the client intentionally skips filtering without calls. Active errors return `fail-closed` and a safe error code; retaining the inventory on errors requires explicit `failMode: "open"`. Use `maxQuestions` to impose a lower provider limit; effective batch size is the smaller of `chunkSize` and `maxQuestions`. The extension requests batches up to 50 and respects a lower limit declared by the selected client. Configure `minCandidates` to change the automatic inventory-size gate. Disabled, unconfigured, or below-minimum prompts make no decision calls. The extension's hooks already add the picked skills for you; no second hook or provider-specific application logic is needed.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Offline tests include provider fixtures, credential precedence/OAuth, malformed responses, deadlines, batching, real extension registration mocks, picker/headless commands, persistence, and the additive ledger lifecycle against an offline stand-in for Pi sessions (branches, compaction, context edits, queued messages, tool rounds), not a live Pi run. Live TypeSafe/OpenRouter and direct Luna checks passed; a terminal visual check has not been performed. Explicitly opt into billable public-fact checks (never part of `npm test`):

```bash
# Only Luna; Pi's saved openai API key works without an env key.
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts gpt-6-luna
# Only TypeSafe (or pass a retained OpenRouter ID).
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts jev-latest
```

The smoke script resolves Pi credentials first, then env; it never substitutes `openai-codex`. `openai` and `luna` are aliases for the explicit Luna target. With no model arguments it checks TypeSafe plus the retained router list, **not Luna**. Without the opt-in it exits before SDK initialization or network activity. It prints safe source-kind/presence booleans/status/scalars/usage, never credentials or raw provider error bodies. Settings use Pi's built-in dialogs/status APIs, including RPC support; the custom allowlist overlay is terminal-only.

## Publishing

The first version is `0.1.0` (already set in `package.json` and `package-lock.json`). npm trusted publishers are configured on an existing package, so publish `0.1.0` once by hand, then switch to tag-driven releases.

```bash
npm ci --ignore-scripts
npm run typecheck && npm test
npm pack --dry-run --ignore-scripts   # inspect the file list
npm login
npm publish                            # publishConfig.access is public; prepublishOnly re-runs typecheck and tests
```

Then on npmjs.com open the package, **Settings, Trusted publishing, Add trusted publisher, GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `championswimmer` |
| Repository | `pi-context-decisions` |
| Workflow filename | `release.yml` |
| Environment | leave empty |
| Allowed actions | tick **Allow npm publish** (see below); leave *npm dist-tag* off |

Per the [npm trusted publishing docs](https://docs.npmjs.com/trusted-publishers/):

- **Allow npm publish is required.** Trusted publisher configurations created after Sep 3, 2026 default to `npm stage publish` only. `release.yml` publishes directly with `npm publish`, so without that tick the release fails. (Alternatively, switch the workflow to `npm stage publish` and approve each release by hand with 2FA.)
- **The first successful publish must happen within 2 days.** A new configuration that is not validated by a publish in that window expires and cannot be edited; delete it and create a new one. Since `0.1.0` is published by hand, create the trusted publisher only when you are ready to push the first tag release (`v0.1.1`) straight away.
- `repository.url` in `package.json` must exactly match the GitHub repository (it does), the runner must be GitHub-hosted, and npm CLI must be >= 11.5.1 (the workflow installs it).
- Trusted publishing works for private repositories, but **provenance is only generated for public repositories**. The repository is currently private, so releases publish without provenance until it is made public. No `--provenance` flag is needed or used.

Later releases: bump, commit and tag with `npm version <major|minor|patch> -m "chore: release v%s"`, then `git push --atomic origin main vX.Y.Z`. [`.github/workflows/release.yml`](.github/workflows/release.yml) verifies the tag matches `package.json`, that the commit is on `main`, runs the tests and publishes with OIDC; no `NPM_TOKEN`. Stable versions go to the `latest` dist-tag; prerelease versions (for example `v1.0.0-rc.1`) go to `next`, because npm refuses to publish a prerelease to `latest` without `--tag`. The project-local `release` skill (`.agents/skills/release`) describes the procedure.

### Automatic changelog and GitHub Releases

Like `../pi-subagent-manager`, [`.github/workflows/changelog.yml`](.github/workflows/changelog.yml) runs independently on the same version tags. It creates or updates the tag's GitHub Release and commits a cumulative [CHANGELOG.md](CHANGELOG.md) to the default branch. Notes use GitHub's generated release notes plus any missing merged PRs from the actual ancestor-tag commit range, including bots and unlabelled PRs. Stable releases compare against the previous stable ancestor (not their RC); major, minor and patch entries are nested, with prereleases separate. Handwritten highlights in GitHub Releases survive regeneration; the publisher rereads the tag's Release before merging highlights and recovers concurrent creation without dropping manual notes. Stable releases delegate GitHub's latest selection with `make_latest: legacy` (using server-side release history rather than a stale local tag snapshot); prereleases use `false`. Do not edit CHANGELOG.md directly.

The workflow uses the repository's automatic `github.token` with `contents: write` and `pull-requests: read`; no new secret or npm permission is needed. npm publishing keeps its existing read-only contents/OIDC permissions. Repository rules must allow this workflow token to update CHANGELOG.md on the default branch; protected-branch refusals fail visibly rather than bypassing protection. Concurrent updates retry with fresh file SHAs and tags, without force pushes or cancelling pending tag runs. Notes remain available even if npm publishing fails; their success does not confirm npm publication.

After merging the automation, **Actions → Publish changelog → Run workflow** can repair an existing tag's GitHub Release, or use an empty tag to rebuild the changelog from all existing version tags without creating a release. It never bumps a version, pushes a tag, or publishes to npm. A local authenticated preview (`GITHUB_REPOSITORY=championswimmer/pi-context-decisions npm run changelog`, with full local tag history and `gh` authentication) calls GitHub and writes CHANGELOG.md locally but makes no remote mutations; `--publish` is reserved for the authorized workflow/recovery procedure.

See [AGENTS.md](AGENTS.md) and `.agents/plans/` for pending contributor handoffs; completed and superseded plans have been removed. [Archived research and live-validation evidence](.agents/research/README.md) retain historical observations, not pending implementation tasks. `../pi-skill-picker-jev` was a pattern reference, not a dependency. The implemented static snapshot and fail-closed defaults above supersede earlier dynamic/fail-open recommendations.
