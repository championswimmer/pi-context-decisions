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

### Decisions history

**`/decisions history`** opens a read-only history route in the same floating dialog (never a second overlay). Newest non-empty batches come first: **↑/↓/PgUp/PgDn** selects a batch, **Enter** shows its names: each added skill or tool shows `value >= threshold` (the raw 0–2 score halved, then the threshold as stored); pinned/allowlisted items show `pinned/allowlisted` or `allowlisted` instead, and an addition with no recorded pick shows `not scored`. **↑/↓/PgUp/PgDn/Home/End** scrolls details, **Esc** returns, and **Ctrl+R** on the list refreshes the committed branch snapshot. Empty turns, unsuccessful picks and uncommitted drafts are omitted. RPC gets a notification report; print/JSON writes the same report to stderr, not the protocol stream. Reports are sanitized and capped at 240 lines / 24,000 characters plus a truncation notice; the terminal viewer can browse every stored batch and name.

A batch groups additions **before each assistant response**, numbered from 1 on the active branch. Additions at `turn_end` (including queued steering) belong to the next response, even if Pi commits them before the queued user message. A batch without a following response is marked **no response yet**. This is committed history, **not proof that a provider request consumed it**, and not a view of what remains visible now. Reload/resume/fork/tree navigation derive history from the current branch; compaction or context edits do not erase historical additions. No new history file or runtime event buffer is maintained.

The details distinguish:

- **Skills advertised** in hidden user-role context messages, versus **re-delivered** skills (not newly picked). These are advertisements of name/description/location metadata, **not loaded skill bodies**.
- **Skills in the system base**, not scored picks: shown only when their base ledger record is confirmed by a subsequent committed Pi system `skills` section. A base record alone is not evidence that another extension left those skills advertised.
- **Tool / MCP-server / extension availability** from the opt-in tool ledger, including allowlisted, unconfigured, fail-open and mid-session-base grants; the old records do not identify the reason or retain scores. Availability does not mean a declaration or description was added to model context. Group names are canonical `mcp__…` / `ext__…` keys.
- **Tool/group notice membership** separately, from committed names-only context notices. Long notices summarize lists in their text, and stored notice membership is bounded; the chunked availability ledger retains all names. Notices do not declare tools. Withholding, release bookkeeping, considered-only records and empty baseline notices are not additions.

History never sends task text or metadata to a decision model, and does not display prompts, assistant text, tool arguments/results, skill bodies, or stored descriptions/paths. It cannot reconstruct old scores, exact scoring triggers, or grants made while tool filtering was off. Tool filtering remains relevance routing, **not a sandbox or permission boundary**.

### Global and project skill allowlists

From `/decisions`, select **Always allowed · Global** or **Always allowed · Project**; the editor opens inside the same dialog and Esc returns to the Skills tab. Like the reference extension's **Always allowed** lists, these are **always-included skill advertisements, not restriction/permission lists**. Matching entries bypass relevance scoring, thresholds, and the per-round cap, join the stable base (so removing an entry never withdraws a skill already advertised on the branch) and remain advertised on fail-closed decision/configuration errors. A global entry matches only user/temporary/global skills; a project entry matches only project-scoped skills. Legacy `pin` names still apply across scopes. Manual-only skills remain unchanged.

- **Global** names are stored as `globalAllowlist` in the user settings file.
- **Project** names are stored in `<cwd>/.pi/pi-context-decisions.json` as `{ "alwaysAllowed": ["skill-name"] }`. It can be shared in the repository; this is scoped to Pi's working directory, so starting in different subdirectories uses different lists. A malformed project list is warned about and treated as empty, not a full-inventory fallback.
- Lists store names only, sorted and deduplicated. Saved names for unloaded skills appear as **(not loaded)** and survive saves unless explicitly removed.

The editor starts in **A-Z**, with immediate local fuzzy search across names and descriptions. **Typing and changing tabs never make decision calls.** Press **Ctrl+R** (or Enter from the search box) for **Relevance** ranking of all loaded skills in the chosen scope against the search term. This explicitly uses the same selected decision backend and 50-skill parallel batches, and may incur charges—even when automatic filtering is disabled. Only search text and skill names/descriptions are sent. Empty searches and missing models/credentials make no call; inline guidance leaves local fuzzy search usable. Query changes mark old results stale; restarting/closing cancels in-flight work.

Keys: **↓** enter list, **↑/↓** navigate, **Space** toggle, **Enter** expand description, **Tab** switch A-Z/Relevance, **Ctrl+K** clear search, **Ctrl+S** save in place. **Esc** returns to search; Esc again closes and discards unsaved changes. Selection changes do not save automatically, and ranking never changes selections. The editors need Pi's terminal UI. RPC and print/JSON clients edit `globalAllowlist` in the settings file or `alwaysAllowed` in `<cwd>/.pi/pi-context-decisions.json` by hand, then `/reload`.

Before the first prompt the editor uses Pi's loaded skill commands. Afterward it uses an in-memory, metadata-only pre-filter inventory snapshot; after `/reload`, a fresh prompt updates it. Project skills still follow Pi project trust. These lists change advertisements only; explicit skill invocation, tools, and MCP access are unchanged.
