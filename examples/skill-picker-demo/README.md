# Thirty-skill picker demo

A runnable sample project in this checkout with **exactly 30 project-local Pi skills** in `.agents/skills/<name>/SKILL.md`. It covers frontend, accessibility, testing, databases, Python, security, payments, infrastructure, and documentation. It is tracked with the main repository; no nested Git repository or separate GitHub remote is required.

Only skill **names and descriptions** go to relevance scoring. The bodies are tiny illustrative instructions, never scoring inputs. Selected skills are advertised in context; Pi loads full bodies separately when needed. This is not an access-control boundary.

## Run offline (no keys, no network, no install in this folder)

Requires Node 22.18+ and the surrounding `pi-context-decisions` source checkout. From this folder:

```bash
npm run demo
npm test
npm run demo -- --prompt "Optimize PostgreSQL reporting queries and plan a safe schema migration." --batch-size 7 --threshold 0.75 --max-skills 4
```

From the extension repository root the equivalent is:

```bash
node --experimental-strip-types scripts/demo-skill-picker.ts
```

The default evaluates **all 30** skills in **three batches of 10**, selects up to six, and prints only safe counts and selected names. It uses an explicitly labelled **offline lexical fixture**, not a trained classifier or a relevance benchmark. `prompts.json` lists illustrative selections; live model outcomes can differ. A deterministic fixture is useful for checking batching/configuration without API charges.

### Configuration

| CLI option | Default | Meaning |
|---|---:|---|
| `--batch-size` | 10 | Questions per scoring call, 1–24 |
| `--threshold` | 0.5 | Inclusive **normalized expected relevance** in [0,1], not probability |
| `--max-skills` | 6 | Maximum selected advertisements, 0–30 |
| `--concurrency` | 2 | Concurrent scoring batches, 1–4 |
| `--timeout-ms` | 15000 | Whole picker deadline, 1–60000 |
| `--prompt` | React/signup/accessibility example | Task text, at most 4000 characters |
| `--backend` | mock | mock, pi, typesafe, openai, or openrouter |
| `--model` | Backend-specific | Classifier model ID |
| `--provider` | typesafe | Native Pi classifier provider; used only with `--backend pi` |

The model rubric is `[irrelevant, related, directly relevant]`, with expected score 0–2. The demo passes the normalized threshold straight to the picker, exactly like the extension's single `relevance.threshold` setting (a skill qualifies when its 0–2 score is at least `2 × threshold`). For example, demo `--threshold 0.75` is extension **Relevance threshold** `0.75` in `/decisions` → **Advanced…**. The demo is a stateless one-shot picker: it does not keep the extension's additive per-branch ledger. Results preserve inventory order after selecting the highest-scoring eligible entries. Zero threshold intentionally allows zero-score skills; use a positive threshold to exclude unrelated skills.

`config/demo-options.json` illustrates programmatic `runDemo` options. It is not auto-loaded. `config/pi-context-decisions.example.json` illustrates a credential-free partial extension config. Configure the real extension with its commands rather than editing credential files.

## Use a real backend (explicitly billable)

Install root dependencies first (`npm ci --ignore-scripts` from the root). The runner uses the same `pickSkills` application API and unified decision client for every backend. It resolves **Pi credentials first, environment variables second**. Pi's public SDK honors `PI_CODING_AGENT_DIR`. No raw auth files are parsed. Direct OpenAI uses the exact `openai` API key, never `openai-codex` OAuth.

Both `--live` and `PI_CONTEXT_DECISIONS_LIVE=1` are required. Choosing a non-mock backend alone makes no request. Live validation of this demo is not part of the default tests.

```bash
PI_CONTEXT_DECISIONS_LIVE=1 npm run demo -- --live --backend typesafe --model jev-latest --batch-size 10
PI_CONTEXT_DECISIONS_LIVE=1 npm run demo -- --live --backend openai --model gpt-6-luna --batch-size 10
PI_CONTEXT_DECISIONS_LIVE=1 npm run demo -- --live --backend openrouter --model typesafe/jev-1.13 --batch-size 10
PI_CONTEXT_DECISIONS_LIVE=1 npm run demo -- --live --backend pi --provider typesafe --model jev-latest --batch-size 10
```

OpenRouter model IDs must be on the checked-in retained list. Native Pi selections must already be registered as classifiers; the demo never replaces Pi provider inventories. No unrelated chat model or full agent session is created. Failure is explicit; it never falls back to advertising all 30.

## Try the actual Pi extension

Run Pi **from this folder**, so these 30 `.agents/skills` directories are discoverable. Load the extension early in the stack:

```bash
pi --extension ../../src/extension.ts
```

Then open `/decisions`, choose a provider and classifier model, switch **Context decisions** on, and in **Advanced…** set:

| Setting | Value |
|---|---|
| Shard size | 10 |
| Relevance threshold | 0.5 |
| Max added per round | 6 |
| Minimum inventory | 0 |
| Concurrency | 2 |
| Timeout | 15000 |
| On failure | closed |

Run `/decisions status` to check the result.

Try a prompt from `prompts.json`; inspect `/decisions status`. Other user/project skills may also be discoverable in your Pi installation, so the real interactive inventory can exceed this fixture's 30. The standalone runner deliberately loads exactly the fixture inventory. A later extension can overwrite skill advertisements; tool/MCP filtering is not implemented.

## Reuse the demo runner

`scripts/demo-skill-picker.ts` exports import-safe `loadDemoSkills`, `parseSkillMetadata`, `parseDemoArgs`, and `runDemo`. `runDemo()` returns `contextSkills` containing selected metadata only, plus rankings and batch counts. It does not mutate the input inventory. Its parser deliberately accepts the demo's strict flat `name`/`description` frontmatter, not arbitrary YAML. Tests check all 30 entries, metadata-only payloads, last-batch coverage, configurable policy, explicit live gates, and zero-network default execution.
