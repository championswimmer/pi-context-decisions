[README](../README.md) · [Documentation](README.md)

# Settings and commands

Run **`/decisions`** to open one **floating dialog** over the session. Output underneath keeps streaming and scrolling. There are three peer tabs:

| Tab | Settings |
|---|---|
| **Skills** | **Skill filtering** on/off (`relevance.enabled`), **Run picker** cadence, global/project skill allowlists, Status, Close. |
| **Tools** | Independent **Tool filtering** on/off (`tools.enabled`), **Mode** (`tools` / `mcp` groups), **Run picker** cadence, and four global/project tool and MCP-server/extension allowlist editors. |
| **Advanced** | Shared **Provider / execution**, **Model**, and all fine-tuning parameters. |

Skills can be off while tools are on, or vice versa. Selecting a provider/model never enables either feature. No master switch is needed.

**Advanced** shows these rows in order: **Provider / execution**, **Model**, **Relevance threshold**, **Shard size**, **Skills · Max added per round**, **On failure**, **Timeout**, **Concurrency**, **Skills · Minimum inventory**, **Prompt size**, **Description size**, **Tools · Max added per round**, **Tools · Minimum candidates**. The provider/model and `decision.*` parameters are common to the entire framework: skill picking, tool/MCP/extension picking and explicit allowlist ranking use the same batching, concurrency, deadline and metadata limits. Threshold and failure policy apply to both automatic pickers; explicit ranking only sorts and never auto-selects anything.

The four labeled skill/tool caps and inventory gates remain feature-specific policy, not duplicate scoring knobs: a tool candidate can enable a whole server/extension, whereas a skill candidate is one advertisement. This also preserves existing defaults (skills: cap **12**, minimum **8**; tools/groups: cap **8**, minimum **0**). Always-allowed and already-added candidates do not consume the cap.

Selecting a parameter edits it inline with strict validation. Cadence, mode and failure policy use option lists; fail-open has a visible framework-wide warning and requires an explicit selection. Legacy `pinned` stays on the `pin`/`unpin` commands, not in the dialog. There are no setter subcommands: everything editable lives here (or in equivalent RPC menus).

Dialog keys: **↑/↓/PgUp/PgDn** move, **Enter** selects, **Space** toggles on/off rows. **Tab/→** cycles Skills → Tools → Advanced → Skills; **Shift+Tab/←** cycles backwards. Switching works only at a tab root, never in an editor or sub-screen. **Esc** returns to the originating tab, and closes from any tab root. While focused, Esc/Ctrl+C act on the dialog, not the running agent. Running `/decisions` again focuses the existing dialog; reload/shutdown closes it and cancels its in-flight work. RPC uses **Skills / Tools / Advanced** select/input sub-menus; allowlist editors remain terminal-only. Print/JSON mode prints status; edit the files below and `/reload` to change settings there.

**No backend is selected by default**, so startup and prompts make no decision calls until you configure one. Selection persists across sessions and opts in to sending bounded task/skill metadata on eligible prompts. Choosing a provider/model does not change either feature switch. Providers and models are labelled **configured** or **missing key**; unavailable selections are rejected without changing settings. Configure the relevant `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` in the environment, or use `/login <provider>` in Pi. Credentials remain Pi-first/environment-second; OpenAI requires its API key, not Codex/ChatGPT OAuth.


## Settings and relevance policy

### Commands

Everything that can be changed lives in the `/decisions` dialog, so the command has almost no arguments:

```text
/decisions
/decisions status
/decisions history
/decisions test
/decisions tools list
/decisions mcp list
```

- `/decisions`: floating settings dialog (TUI), select/input menus (RPC), or status (print/JSON).
- `/decisions status`: credentials, last decision, allowlist counts and tool filtering; no inference calls.
- `/decisions history`: read-only committed additions on this branch; no inference calls.
- `/decisions test`: explicit synthetic bool call to the selected model; may incur cost.
- `/decisions tools list`: read-only, names-only tool inventory and availability.
- `/decisions mcp list`: read-only MCP-server and extension-group inventory and availability.
- `/decisions pin <skill>` and `/decisions unpin <skill>`: legacy always-included skill names, not in the dialog. Replace `<skill>` with a loaded skill's name.

Removed in favour of the dialog: `settings`, `relevance <key> <value>`, `provider`, `model`, `enable`, `disable`, `allow`, `allowlist`, and every `tools`/`mcp` setter. They now answer with a usage line and change nothing. In a terminal there is nothing to type; RPC clients use the same menus; print/JSON runs edit `settings.json` and the project allowlist file by hand and `/reload`.

Settings live in `<Pi agent dir>/pi-context-decisions/settings.json`, atomically written with mode `0600`. Defaults:

- Relevance enabled, **score-only**; skips fewer than **8 unique automatic skills** (everything stays advertised) and empty prompts (no picks).
- Score rubric: **irrelevant → related → directly relevant** (indices 0–2). A skill's score is an expected rubric index, not a class probability or confidence; normalized score = score/2. The single **threshold** is that normalized score in [0, 1], inclusive: a skill qualifies when its 0–2 score is at least `2 × threshold`. The default **0.375** equals the previous raw 0.75 ("related"). There is no choice mode, minimum label or second threshold: the decision `choice` primitive still exists in the library, but skill picking does not use it.
- Add up to **12 new** skills per round (*max added per round*, best first across all shards); pinned and scoped always-allowed names bypass scoring/cap/threshold. There is no session-total cap. Original skill references are preserved. Manual-only skills are not sent for classification.
- **Fail closed**: a failed round adds nothing; existing advertisements/availability stay. Shared `decision.failMode: "open"` explicitly adds every remaining candidate in either picker when scoring fails; configuration errors and aborts always fail closed.
- **Upgrading:** legacy files migrate **in memory only**, with one migration warning; loading never rewrites the file. The next successful save writes only the canonical shape below. `decision.*` values win per field. Otherwise, legacy `relevance.*` scoring controls and `tools.threshold/failMode/maxDescriptionChars` populate the shared section; conflicting legacy thresholds use the **higher** value, descriptions the **shorter** limit, and failures **closed** if either was closed. Missing controls take existing defaults. Old top-level `enabled: false` disables both feature switches on migration; afterwards each can be enabled independently.
- Pre-score-only keys still migrate: raw `relatedThreshold / 2`, or `directThreshold / 2` when `minLabel` was `directly_relevant`, becomes the legacy skill threshold; an explicit `relevance.threshold` beats those older keys before the shared merge. `mode: "choice"` migrates to scores. **Every legacy value is validated even when shadowed by `decision.*`**; invalid values stay visible settings errors and fail closed.
- Whole round deadline **8000ms**, requested shards of **50 candidates**. Concurrency **0** means every shard starts in parallel: 300 candidates use six shards; 400 use eight. Set concurrency 1–32 to limit simultaneous shards per pass; skill and tool passes can run concurrently. A lower declared provider/client question limit reduces effective shard size, without omitting candidates.
- Configurable prompt ≤4000 characters and each description ≤400; names ≤64, JSON state ≤65536 characters per batch, inventory ≤1000 unique candidates. These are local safety bounds, not provider token-limit guarantees.

Canonical settings shape (defaults):

```json
{
  "iconStyle": "unicode",
  "backend": null,
  "globalAllowlist": [],
  "decision": {
    "threshold": 0.375,
    "chunkSize": 50,
    "concurrency": 0,
    "timeoutMs": 8000,
    "failMode": "closed",
    "maxPromptChars": 4000,
    "maxDescriptionChars": 400
  },
  "relevance": {
    "enabled": true,
    "cadence": "prompt",
    "maxSkills": 12,
    "minCandidates": 8,
    "pinned": []
  },
  "tools": {
    "enabled": false,
    "mode": "tools",
    "cadence": "prompt",
    "maxAdded": 8,
    "minCandidates": 0,
    "alwaysAllowedTools": [],
    "alwaysAllowedMcpServers": []
  }
}
```

Invalid persisted settings are reported explicitly and advertisements fail closed until repaired in the dialog or with a file edit + `/reload`. Unknown read fields are ignored with a warning; writes reject unknown fields and credentials. Failed writes do not change the active configuration.

### Compact footer

Choose **Footer icons** under `/decisions` → **Advanced**: **ASCII / Unicode** (default, no patched font), **Emoji**, or **Nerd Font** (requires a Nerd Font terminal font). The saved `iconStyle` is `unicode`, `emoji`, or `nerd`; older settings files default to Unicode.

```text
◇ ≡ 12/40 ⚙ 18/120      ASCII / Unicode
🎯 📚 12/40 🔧 18/120    Emoji
◇ ≡ 12/40 ⚙ 3/15g       Group mode (Unicode)
```

The leading diamond, target or filter identifies Context Decisions; skills use a list/books/book icon and tools use a gear/wrench. Nerd Font uses the classic Font Awesome filter (`U+F0B0`), book (`U+F02D`) and wrench (`U+F0AD`) glyphs rather than the less portable scroll. Every count is separated from its icon by a space. Skills show **advertised / total invocable skills**, not loaded skill bodies or new additions this round. Tools show **available / total external tools** (built-ins excluded); `g` means MCP-server and extension **groups** instead. Tool counts stay hidden while tool filtering is off. `ready` means no round recorded yet, `setup` means select a model, and `off` means disabled. Short flags such as `!timeout`, `!config`, `!host` (missing host APIs), or `!open` (explicit fail-open fallback) preserve failure visibility. Timings, cache information and detailed reasons remain in `/decisions status`.

### Decisions history

**`/decisions history`** opens a read-only history route in the same floating dialog (never a second overlay). Newest non-empty **user-prompt turns** come first, for example `Turn 1: (3 skills, 2 tools/MCPs added)` and `Turn 20: (1 skills, 1 tools/MCPs added)`. **↑/↓/PgUp/PgDn** selects a prompt; **Enter** expands its internal-turn breakdown and added names. **↑/↓/PgUp/PgDn/Home/End** scrolls details, **Esc** returns, and **Ctrl+R** on the list refreshes the committed branch snapshot. RPC gets the same grouped notification report; print/JSON writes it to stderr, not the protocol stream. Reports are sanitized and capped at 240 lines / 24,000 characters plus a truncation notice; the terminal viewer can browse every stored turn and name.

**Turn numbering** is the one-based, cumulative **assistant-response index on the active branch**, including assistant tool-call rounds, errors and aborted responses. It does not restart at each prompt (unlike Pi's per-run lifecycle `turnIndex`), and does not count tool results, system messages or extension notices as separate turns. If 19 assistant responses follow the initial prompt, the next user prompt is **Turn 20**. Each committed native `user` message starts a top-level prompt, including queued steering/follow-up users; multiple users before the same assistant response share one row, because they have the same turn index. Pi persists no separate steering/source flag, so history does not guess one from message text. A hidden custom message is not a user prompt.

Internal additions are grouped **before the next assistant response**. Initial ledger records before the user and `turn_end` additions before a queued user belong to that same response boundary and user prompt. Subsequent tool rounds without another user stay nested under the preceding prompt. Before any native user exists, records are grouped under an initial Turn 1 fallback. A boundary without a following response is marked **no response yet**. Prompts with no history events are omitted; re-delivery-only or notice-only prompts remain browsable with zero new-addition counts. Unsuccessful picks and uncommitted drafts are omitted.

The overview counts newly advertised skills (including confirmed base/pinned skills) and new tool-ledger grants. Re-deliveries and notice membership do not inflate those counts. In MCP/group mode, **MCP servers and extensions are equivalent bulk additions**: a recorded `mcp__…` or `ext__…` key is shown and counted once, never expanded into member tools. Tools-mode grants show individual tool names. New group-mode records omit member grants already covered by a whole-group grant (including individual pins that promote a homogeneous group); mixed-origin pins remain individual when no whole-group grant exists. Whole-group grants remain available after pin removal or a switch to tools mode.

For compatibility, old records can contain both a tool and its group. History collapses known members alongside a group granted at the **same response boundary**, including chunked records, using names-only membership from the filter's **existing session registry snapshot**. Reading history never refreshes the registry, scores anything, or persists a membership map. Earlier tools-mode additions are not erased when a later turn promotes their group. **Old records store no group membership:** when the snapshot is absent or a tool is unloaded/unknown, both identifiers remain visible/countable rather than guessing from name prefixes. A snapshot describes known session tools, not proof of their historical provenance if tool names were reused; history cannot fully reconstruct those old grants. Today's mode never relabels old records.

Compact details distinguish:

- **Skills advertised** in hidden user-role context messages, versus **re-delivered** skills (not newly picked). These are advertisements of name/description/location metadata, **not loaded skill bodies**. Added skills/tools/groups show `score 1.6 / ≥0.75`, for example: the recorded **raw 0–2 score** and the minimum on that **same scale** (twice the stored normalized threshold). This is the relevance rubric score, not confidence or a textual explanation. No precision is discarded. Allowlist grants show `pinned (allowlist)` with no score, and re-deliveries show `re-delivered` rather than inventing a new pick.
- **System base skills**, not scored picks: shown only when their base ledger record is confirmed by a subsequent committed Pi system `skills` section. A base record alone is not delivery evidence. Each confirmed base skill shows `base (unfiltered)`: filtering was bypassed (off, unconfigured, or below the minimum), but the record does not distinguish which.
- **Tool / MCP / extension availability** from the opt-in tool ledger. Availability is not a declaration or proof that a description entered model context.
- **Notice membership**, summarized as names only (`+ mcp__exa`, for example), never the raw availability notice text. A notice at the same boundary is marked inline `· notice` beside its availability grant rather than repeating the name. Later/notice-only deliveries retain their own section. Long notice text may summarize lists; stored notice membership is bounded, while chunked availability records retain every name. Withholding, release bookkeeping, considered-only records and empty baseline notices are not additions.

Successful scored skill and tool/group grants retain numeric picks through prompt, initial-tool cadence, cached tool-round additions, catch-up, and lazy-tool decisions (including an `agent_end` flush). A notice at a later boundary can show the original committed grant's score/threshold; it is not a new decision. **Missing picks show `unknown (no recorded pick)`**. Older records, fail-open additions, unconfigured/below-minimum tool grants, mid-session tool bases, and groups promoted from already available tools (without a new group decision) cannot be distinguished from the existing names-only records. In particular, history must not invent a `fail-open` reason or score. No reason flags, new history records, or persisted buffers are added.

This is committed history, **not proof that a provider request consumed it**, and not a view of what remains visible now. Reload/resume/fork/tree navigation derive it from the current branch; compaction and context edits do not erase historical additions or renumber responses. No new history file or runtime event buffer is maintained.

History never sends task text or metadata to a decision model, and does not display prompts, assistant text, tool arguments/results, skill bodies, or stored descriptions/paths. It cannot reconstruct old scores, exact scoring triggers, or grants made while tool filtering was off. Tool filtering remains relevance routing, **not a sandbox or permission boundary**.

### Global and project skill allowlists

From `/decisions`, select **Always allowed · Global** or **Always allowed · Project**; the editor opens inside the same dialog and Esc returns to the Skills tab. Like the reference extension's **Always allowed** lists, these are **always-included skill advertisements, not restriction/permission lists**. Matching entries bypass relevance scoring, thresholds, and the per-round cap, join the stable base (so removing an entry never withdraws a skill already advertised on the branch) and remain advertised on fail-closed decision/configuration errors. A global entry matches only user/temporary/global skills; a project entry matches only project-scoped skills. Legacy `pin` names still apply across scopes. Manual-only skills remain unchanged.

- **Global** names are stored as `globalAllowlist` in the user settings file.
- **Project** names are stored in `<cwd>/.pi/pi-context-decisions.json` as `{ "alwaysAllowed": ["skill-name"] }`. It can be shared in the repository; this is scoped to Pi's working directory, so starting in different subdirectories uses different lists. A malformed project list is warned about and treated as empty, not a full-inventory fallback.
- Lists store names only, sorted and deduplicated. Saved names for unloaded skills appear as **(not loaded)** and survive saves unless explicitly removed.

The editor starts in **A-Z**, with immediate local fuzzy search across names and descriptions. **Typing and changing tabs never make decision calls.** Press **Ctrl+R** (or Enter from the search box) for **Relevance** ranking of all loaded skills in the chosen scope against the search term. This explicitly uses the same selected decision backend and 50-skill parallel batches, and may incur charges—even when automatic filtering is disabled. Only search text and skill names/descriptions are sent. Empty searches and missing models/credentials make no call; inline guidance leaves local fuzzy search usable. Query changes mark old results stale; restarting/closing cancels in-flight work.

Keys: **↓** enter list, **↑/↓** navigate, **Space** toggle, **Enter** expand description, **Tab** switch A-Z/Relevance, **Ctrl+K** clear search, **Ctrl+S** save in place. **Esc** returns to search; Esc again closes and discards unsaved changes. Selection changes do not save automatically, and ranking never changes selections. The editors need Pi's terminal UI. RPC and print/JSON clients edit `globalAllowlist` in the settings file or `alwaysAllowed` in `<cwd>/.pi/pi-context-decisions.json` by hand, then `/reload`.

Before the first prompt the editor uses Pi's loaded skill commands. Afterward it uses an in-memory, metadata-only pre-filter inventory snapshot; after `/reload`, a fresh prompt updates it. Project skills still follow Pi project trust. These lists change advertisements only; explicit skill invocation, tools, and MCP access are unchanged.
