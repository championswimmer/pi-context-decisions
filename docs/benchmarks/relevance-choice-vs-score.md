# Per-skill choice vs score for skill advertisement relevance — live benchmark

Measured **2026-10-13 UTC** on the repository's 30-skill demo (`examples/skill-picker-demo`), baseline commit `9b1796c` (v0.2.0), Node 26.11.1, Pi 1.1.0 SDK for credential lookup. This document combines (a) a small live benchmark run against five retained OpenRouter decision models and (b) the research in [`.agents/research/choice-score-skill-selection-2026-10-13.md`](../../.agents/research/choice-score-skill-selection-2026-10-13.md).

> **Status — historical measurement; production has since become score-only.** This benchmark measured the **v0.2.0** extension (commit `9b1796c`), where relevance had two production modes (`score` and per-skill `choice`), raw 0–2 `relatedThreshold` / `directThreshold` settings and a `minLabel` floor. The current production picker is **score-only**: `mode`, `minLabel`, `relatedThreshold`, `directThreshold` and the per-skill label are removed (passing them is a configuration error), and eligibility is one **normalized** threshold (default **0.375**, i.e. a skill qualifies when its 0–2 score is at least `2 × threshold` = 0.75) plus a maximum count. Wherever this document says “production”, “deployed”, “`mode: "choice"`”, “label floor” or quotes the raw 0.75 / 1.5 thresholds, it describes **v0.2.0 behavior at measurement time**, not current defaults.
>
> - The **score** arm's selection is unchanged by that change (0.375 ⇒ raw 0.75; same ranking, same cap of 12), so its measurements remain valid for the current score-only policy.
> - The per-skill **choice** arm is now a **historical comparator**: it reproduces what the removed mode did, implemented inside the benchmark script from the core decision primitive. It is not shipped as an application mode.
> - The raw JSON is the unmodified historical record; its recorded `policy` is the v0.2.0 policy.

> **Read this first.** This is a **small descriptive snapshot** — 4 tasks, 2 repeats, 5 models, one network location, one annotator — not a statistical study. No confidence intervals or significance tests are reported because the sample cannot support them. Numbers show what happened in this run; they are not general accuracy, speed or model-ranking claims. Nothing here changes production behavior, defaults or the static model catalog.

## Summary

- **All 100 requests succeeded.** 100 physical POSTs = 100 logical decision calls, **0 failures, 0 non-200 responses, 0 transport retries, 0 timeouts**. Every per-skill run (80 of them) scored **all 30 candidates in one 30-question batch**. Provider-reported cost totals **$0.048822** (≈ $0.0488).
- **The two deployed methods behaved alike in this sample.** Per-skill ordered `score` and per-skill categorical `choice` (three labels), both with identical prompt, metadata, instructions and rubric text, gave pooled F1 0.55 vs 0.54, recall 1.00 vs 0.98 and pooled median picker time 457 ms vs 444 ms under the deployed policy. Differences between *models* were far larger than differences between *methods*.
- **Calibration is model-specific, and the default thresholds are permissive here.** With the extension defaults (related ≥ 0.75, cap 12) the picker advertised about 10 of 30 skills for tasks that need 3–4, and in 38 of 80 per-skill runs more than 12 skills were eligible, so the cap was binding. One model (`perplexity/pplx-decider-v1.1-27b`) scored almost everything near 1: **22–30 of 30 skills were eligible (uncapped) on every prompt**, in both arms and both trials, including 25 (score) and 22 (per-skill choice) on the unrelated control. The cap of 12 then kept 12 on every prompt.
- **`argmax` choice and score thresholds are not interchangeable even on the same answer.** Across all 240 recorded verdicts per model in the choice arm, the deployed label rule disagreed with the score-style 0.75/1.5 labels on the same answer for 6–27 of 240 skill verdicts per model, and on whether a skill is eligible for 2–15 of them (table below).
- **A single-winner `choice` over all 30 skills is not a multi-skill selector.** It is the fastest call (one question) and was usually precise, but its recall is capped at 1/|needed skills| (mean ceiling 0.28 on these tasks; observed 0.24).
- **Recommendation (task-fit, not a measured win):** keep per-skill `score` as the default for thresholded, capped ranking; use per-skill `choice` when a literal categorical verdict is the desired policy; tune thresholds per model on labeled held-out tasks before trusting either.

## What was compared

| Arm (raw-report id) | What it is | How selection works |
|---|---|---|
| **score** (`score`) | **Production** `mode: "score"` at measurement time (today's only mode, run through the current `pickSkills` with normalized threshold 0.375): 30 independent per-skill questions, each with three ordered rubric levels. | The answer is the expected zero-based level index in [0, 2] (`p(related) + 2·p(directly relevant)`), **not a probability and not a confidence**. Local thresholds turn it into a label (`< 0.75` irrelevant, `≥ 0.75` related, `≥ 1.5` directly relevant); skills at or above `minLabel = related` are eligible, ranked by score, capped at 12. |
| **per-skill choice** (`choice-label`) | **Production `mode: "choice"` in v0.2.0 (since removed)**; the script now runs it as a **historical comparator**: the same 30 per-skill questions with the same three level descriptions, but each question asks the model to **pick one label** (`irrelevant` / `related` / `directly_relevant`). The measured raw data came from the production mode itself; the comparator reproduces its requests and selection rule, which an offline test pins to the production score request's state and instruction text. | Skills whose returned label is `related` or better are eligible. Within eligible skills the extension ranks by `2·p(directly relevant) + p(related)` when the provider returned a distribution, and by 0/1/2 from the hard label when it did not (ties then resolve in inventory order). Score thresholds do **not** relabel a choice answer. |
| **single-winner choice** (`choice-shortlist`) | **Exploratory, not deployed.** *One* choice question whose options are the 30 skill names plus `none`; each option's description is the skill description. | One winner (or `none`). The returned option probabilities, when present, can rank the rest, but they are a distribution **among competing skills**, not independent per-skill usefulness. Compared directly with the per-skill classification above, it asks one question instead of 30 and returns one winner, so it cannot express a multi-skill selection by itself. |

**How the script runs the arms today** (the committed raw data was produced when both per-skill arms went through `pickSkills` with `mode` as the only difference): the score arm calls the current score-only `pickSkills`; the choice arm builds the per-skill choice requests locally (frozen v0.2.0 level text; same state and instructions as the score request), sends them through the same decision client, takes the argmax label, derives the ranking value `2·p(direct) + p(related)` (or the hard-label index without a distribution), keeps labels at `related` or better and applies the same cap of 12; the single-winner arm builds one `DecisionRequest` and calls the same decision client directly. Offline tests check that the comparator's payload matches the production score request and that 0.375 selects exactly like the historical raw 0.75 floor.

Why these two per-skill modes are not the same decision even with identical rubric text (research conclusions): `choice` returns the most probable label, while `score` returns a probability-weighted mean. A score of 1 can mean certainty at “related” or a 50/50 split between irrelevant and directly relevant. With `[irrelevant .40, related .35, direct .25]`, argmax says irrelevant but the expectation 0.85 passes the default related threshold; with `[.35, .20, .45]` argmax says directly relevant but the expectation 1.10 is below the default direct threshold 1.5. No single score threshold reproduces a three-way argmax. Level descriptions should also be concrete and independently understandable (not “better than the previous level”); the shipped rubric text was **not varied** in this benchmark.

## Setup

### Rerunnable configuration (what was actually run)

The relevance **thresholds, label floor, cap and batching/concurrency** are the v0.2.0 extension defaults from `src/settings.ts`, recorded in the raw report's `policy` field (the current score-only equivalent is normalized threshold 0.375). Two **benchmark-specific overrides** differ from the automatic hook and are disclosed here: `minCandidates 0` (explicit `pickSkills` semantics; the automatic hook defaults to 8) and a **30 s** timeout (production default 8 s). `failMode closed` and the absence of pins match the defaults. Everything the live requests used is in the table.

**Historical policy note.** Reports written by earlier versions of the script record this v0.2.0 policy (`relatedThreshold 0.75`, `directThreshold 1.5`, `minLabel related`); reports written now record `policyVersion 2` (normalized `threshold 0.375`, cap 12, plus a marker that the choice arm is the historical comparator). A resume accepts either, because the current policy selects identically; any other policy is `incompatible`. Production defaults changing again would likewise require a fresh `--output`, and this snapshot must always be read against the policy recorded in its own file.

| Setting | Value |
|---|---|
| Inventory | the 30 demo skills; only `name` + `description` (≤ 64 / ≤ 400 chars) and the task text are sent; no bodies, paths or transcripts |
| Batching | `chunkSize 50`, `maxQuestions 50`, `concurrency 0` ⇒ one batch of 30 questions per call |
| Eligibility | historical (recorded): `relatedThreshold 0.75`, `directThreshold 1.5`, `minLabel related`; current equivalent: normalized threshold 0.375 (`score ≥ 0.75`) |
| Cap | `maxSkills 12` (extension default) |
| Failure mode / inventory minimum | `closed` (default); `minCandidates 0` (**benchmark override**; automatic hook default 8); no pins |
| Timeout | **30 s** per benchmark call (**benchmark override**; production default 8 s; no run exceeded 8 s, see below) |
| Endpoint | OpenRouter direct decisions endpoint via the project's `createOpenRouterBackend` and `createDecisionClient` (default transport retry policy: up to 2 attempts; every physical attempt was counted) |
| Models | `typesafe/jev-1.13`, `perplexity/pplx-decider-v1.1-27b`, `cloudflare/clef-flash`, `liquid/d1`, `microsoft/microsoft-decision-1` — five of the eight entries in the static retained catalog. Resolved response builds: `typesafe/jev-1.13-20260917`, `perplexity/pplx-decider-v1.1-27b-20261006`, `cloudflare/clef-flash`, `liquid/d1-20260930`, `microsoft/microsoft-decision-1-20261009` |
| Design | 5 models × 4 tasks × (2 trials × 2 per-skill arms + 1 single-winner call) = **100 requests**. Calls were sequential. Per-skill arm order alternated between trials (trial 1: score then choice; trial 2: choice then score); the single-winner call ran last in each group |
| Budget | **Hard** cap: 100 physical requests (every started HTTP attempt, including transport retries, counted across resumes; a counting `fetch` wrapper refuses to start attempts beyond it). **Soft** cost threshold: $5, a stopping rule on provider-reported `usage.cost`, checked **between** runs, so an in-flight call can overshoot it and charges the provider does not report are never seen. It is not a hard dollar cap |

Reproduce (billable; refuses to run without both gates):

```bash
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/benchmark-relevance-methods.ts \
  --live --output /tmp/relevance-methods-rerun.json
```

With the score-only production code, the script's score arm uses the current picker and its choice arm the historical comparator, so a live rerun measures the current policy against the historical per-skill choice experiment, not against a production mode.

The output file is **resumable**: completed records are skipped, so pointing `--output` at the committed `docs/benchmarks/relevance-methods-raw.json` makes no calls and leaves the file byte-for-byte unchanged (an offline test enforces this against the committed snapshot).

Resume rules (all enforced before any request is made; a rejected resume does not modify the file):

- **Compatibility.** The existing file must have the same protocol policy, request timeout, skill inventory (names, and descriptions via a `sha256` recorded in newly written files; the committed snapshot predates the hash, so only its names are compared) and, for every case being resumed, the same task text and the same `required` / `acceptable` label sets. Otherwise the run fails with code `incompatible` and the message to **use a fresh `--output` path**. Models, trial counts, budgets and brand-new case ids may differ and extend the file; existing case definitions are never replaced. A corrupt or non-benchmark output file is rejected rather than overwritten.
- **Retries keep their history.** `--retry-failed` re-runs only records whose latest outcome is a failure. The superseded failed record moves to an `attempts` array in the report instead of being erased, so cumulative physical requests, failure codes and reported cost are never undercounted, and both budget controls use the **cumulative total across every resume**: `--max-requests` is a hard cap on started attempts, `--max-cost-usd` a soft stopping threshold on reported cost. `--summarize` prints an accounting line (records, superseded attempts, cumulative requests, failed attempts, final failures, failure codes, cost). The committed snapshot has no retries, hence no `attempts` array: 100 records, 100 cumulative requests, 0 failed attempts. Re-render every table in this document offline from the raw report with
`node --experimental-strip-types scripts/benchmark-relevance-methods.ts --summarize docs/benchmarks/relevance-methods-raw.json`.
Live results will differ: models, routing and account state change.

### Credentials

Request-time order follows the project: Pi's public credential registry first, then `OPENROUTER_API_KEY`. The raw report records presence flags only: `piKeyPresent: true` (the Pi lookup returned an OpenRouter credential during the run) and `envKeyPresent: true`. Because Pi is consulted first, a request uses the environment key only when the Pi lookup returns none (or fails); the benchmark does **not** record the source per call, so this document does not claim the environment key was used. No key, header or provider error body is printed or stored in the report (checked by an exact-value search of the raw file).

### Pilot disclosure

The first three requests (`typesafe/jev-1.13`, `react-signup`, trial 1, all three arms) were a pilot run of the same measurement code and configuration (later changes to the script touched only resume bookkeeping and offline summaries). Because the output file is resumable, those records are **kept** in the data and count against the 100-request budget; nothing was discarded or rerun.

### Tasks and labels

Four tasks (`examples/skill-picker-demo/benchmark-cases.json`), with expectations fixed **before any live output was seen**:

| Task | Needed skills (`required`) | Plausible adjacent help (`acceptable`) |
|---|---|---|
| `react-signup` — accessible React signup form with validation and browser tests | react-components, web-accessibility, form-validation, browser-testing | authentication, typescript-types, unit-testing, css-layout, product-copy, security-review |
| `payments-checkout` — payment checkout with idempotent webhooks and confirmation email | payments, email-delivery, node-api | security-review, api-contracts, redis-cache, authentication, unit-testing |
| `k8s-deploy` — Docker containers to Kubernetes with GitHub Actions CI and health metrics | docker-containers, kubernetes-deploy, github-actions, observability | terraform-infra, incident-response, git-workflows, security-review |
| `unrelated-eclipse` — explain lunar vs solar eclipses to a ten-year-old (control) | none | none |

**Label limitations.** Labels are one annotator's judgments (written by the agent that implemented the benchmark from the skill descriptions; not adjudicated by multiple people or a domain expert). The `acceptable` sets are subjective: any selected skill outside `required ∪ acceptable` counts as *off-topic*, and for the control **any** selection counts as a false positive, even where arguable (for example `product-copy` for a children's explanation). With 3 positive tasks, one flipped label moves per-task recall by 25–33 points. The skill descriptions deliberately overlap (several skills mention forms, testing or APIs), so “adjacent” skills are easy to rate related.

### Metrics

- **Eligible (uncapped)**: skills passing the label floor `related`. **Kept (cap 12)**: the production result.
- **Precision / recall / F1** against `required` (averaged over the 3 positive tasks × models × trials; empty selection ⇒ precision 0). **Off-topic**: kept skills outside `required ∪ acceptable`. **Unrelated picked**: skills kept for the control.
- **req@R**: fraction of the `R` required skills inside the top `R` by raw score, **ties resolved against the arm**.
- **Stability**: mean Jaccard between the two trials' selections.
- **Picker end-to-end time** (`e2e`): wall clock (`performance.now`) from calling `pickSkills` until the validated, filtered selection is returned (candidate bounding, request building and validation, Pi credential lookup, HTTP POST and response read, response decoding/validation, eligibility, ranking, cap). For the single-winner arm, from building the request until the validated answer. It is split into **prep** (before the first decision call), **decide** (client call: validation, credential lookup, transport, parsing) and **post** (interpretation and selection). **Not included:** Node start-up, loading skill metadata, one-time Pi credential-runtime initialization, any Pi agent turn, loading skill bodies, or task completion. This is *picker* end-to-end, not full-agent end-to-end. Each model's first call also includes any connection set-up.

## Results

### 1. Completeness, failures and retries

| Measure | Result |
|---|---|
| Records / logical calls / physical requests | 100 / 100 / 100 |
| Failed runs (any error code) | **0** |
| Non-200 HTTP responses | **0** |
| Transport retries (physical − logical) | **0** |
| Timeouts or fail-closed selections | **0** |
| Per-skill runs that evaluated all 30 candidates | 80 / 80 (batch sizes `[30]`) |
| Single-winner runs | 20 / 20 returned a valid answer with option probabilities |
| Requests ≥ 1 s | 4 (jev-1.13 choice 1,647 ms; pplx score 5,704 ms *(its first call of the run)*; pplx choice 1,055 ms; pplx score 1,581 ms) |
| Requests over the 8 s production deadline | **0** (maximum 5,704 ms) |

### 2. Picker end-to-end time

Pooled across the five models:

| Arm | n | e2e mean (ms) | median (ms) | min–max (ms) | mean request body (bytes) | reported cost |
|---|---:|---:|---:|---:|---:|---:|
| score | 40 | 619 | 457 | 254–5704 | 15,613 | $0.023846 |
| choice-label | 40 | 515 | 444 | 290–1647 | 16,933 | $0.024279 |
| choice-shortlist | 20 | 306 | 279 | 201–758 | 4,629 | $0.000696 |

Per model and arm (ms; `n` = 8 per-skill runs or 4 single-winner runs; “decide share” is the fraction of e2e inside the decision client call):

| Model | Arm | n | e2e mean | median | min–max | decide share | prep+post mean | requests | reported cost | cost/request |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cloudflare/clef-flash | score | 8 | 500 | 494 | 414–615 | 99.9% | 0.39 ms | 8 | $0.000824 | $0.000103 |
| cloudflare/clef-flash | choice-label | 8 | 537 | 529 | 447–649 | 99.9% | 0.47 ms | 8 | $0.000844 | $0.000106 |
| cloudflare/clef-flash | choice-shortlist | 4 | 424 | 332 | 276–758 | 100.0% | 0.01 ms | 4 | $0.000109 | $0.000027 |
| liquid/d1 | score | 8 | 401 | 366 | 336–570 | 99.8% | 0.68 ms | 8 | $0.014220 | $0.001778 |
| liquid/d1 | choice-label | 8 | 400 | 378 | 354–534 | 99.9% | 0.46 ms | 8 | $0.014201 | $0.001775 |
| liquid/d1 | choice-shortlist | 4 | 218 | 215 | 201–242 | 100.0% | 0.01 ms | 4 | $0.000131 | $0.000033 |
| microsoft/microsoft-decision-1 | score | 8 | 492 | 440 | 421–862 | 99.9% | 0.61 ms | 8 | $0.001057 | $0.000132 |
| microsoft/microsoft-decision-1 | choice-label | 8 | 436 | 436 | 421–456 | 99.9% | 0.39 ms | 8 | $0.001158 | $0.000145 |
| microsoft/microsoft-decision-1 | choice-shortlist | 4 | 311 | 297 | 286–363 | 100.0% | 0.01 ms | 4 | $0.000140 | $0.000035 |
| perplexity/pplx-decider-v1.1-27b | score | 8 | 1404 | 688 | 574–5704 | 100.0% | 0.31 ms | 8 | $0.006310 | $0.000789 |
| perplexity/pplx-decider-v1.1-27b | choice-label | 8 | 713 | 681 | 588–1055 | 99.9% | 0.60 ms | 8 | $0.006349 | $0.000794 |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 4 | 317 | 279 | 276–437 | 100.0% | 0.01 ms | 4 | $0.000078 | $0.000020 |
| typesafe/jev-1.13 | score | 8 | 298 | 266 | 254–505 | 99.7% | 0.75 ms | 8 | $0.001435 | $0.000179 |
| typesafe/jev-1.13 | choice-label | 8 | 486 | 319 | 290–1647 | 99.9% | 0.53 ms | 8 | $0.001727 | $0.000216 |
| typesafe/jev-1.13 | choice-shortlist | 4 | 261 | 257 | 233–297 | 100.0% | 0.05 ms | 4 | $0.000238 | $0.000060 |

Observations (descriptive only):

- Time is dominated by the network/provider call (decide share ≥ 99.7 %). Local prep + post stay under about 1 ms for 30 candidates. Credential lookup was 0.03–0.6 ms on average.
- Pooled per-skill medians are within 13 ms (457 vs 444 ms). Per-model means differ in **both** directions (jev: score 298 vs choice 486; pplx: 1,404 vs 713), but two outliers drive those means; the medians (jev 266 vs 319; pplx 688 vs 681) are much closer. There is no basis here to say either method is faster.
- The single-winner call is fastest per model, but it sends **one question and about 4.6 KB instead of 30 questions and about 15.6–16.9 KB**, so that gap reflects payload size as much as method.
- Timing is a sequential single-location sample with 8 observations per cell; tail latency is deliberately not reported. A 3×10 batch split (parallel) was not measured.

### 3. Cost

| Model | input tokens (sum, 3 arms) | output tokens (sum, 3 arms) |
|---|---:|---:|
| cloudflare/clef-flash | 84,628 | 0 |
| liquid/d1 | 713,805 | 0 |
| microsoft/microsoft-decision-1 | 56,064 | 484 |
| perplexity/pplx-decider-v1.1-27b | 636,876 | 484 |
| typesafe/jev-1.13 | 80,959 | 15,628 |

Cost source: the per-response `usage.cost` field returned by OpenRouter, summed by the benchmark (all 100 responses reported it). It is **not reconciled against an account statement**; any charge not reflected in that field is unaccounted for. Totals: **$0.048822** overall; score arm $0.023846 (40 requests), per-skill choice $0.024279 (40), single-winner $0.000696 (20). Token counts are provider-reported and **not comparable across models** (tokenizers and accounting differ; several providers report 0 or a constant per-answer count of output tokens). Between the two per-skill arms, per-model cost differs by 0.1–20 % (the largest: jev-1.13 choice costs 20 % more than score); between models it differs by up to ~17× for identical prompts (liquid/d1 ≈ $0.0018 per per-skill call vs cloudflare/clef-flash ≈ $0.0001).

### 4. Selection quality under the deployed policy (rerunnable settings)

Defaults as above (related ≥ 0.75, cap 12). 30 positive-task runs and 10 unrelated runs per per-skill arm:

| Arm | kept (mean) | precision | recall | F1 | off-topic | unrelated runs with any pick | unrelated picked (mean) |
|---|---:|---:|---:|---:|---:|---:|---:|
| score | 10.33 | 0.39 | 1.00 | 0.55 | 3.13 | 6/10 | 3.00 |
| per-skill choice | 10.27 | 0.38 | 0.98 | 0.54 | 3.20 | 4/10 | 2.60 |

Per model and arm (cap 12; includes the single-winner arm for reference):

| Model | Arm | selected (mean) | precision | recall | F1 | req@R | off-topic | unrelated picked | stability |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cloudflare/clef-flash | choice-label | 7.00 | 0.56 | 1.00 | 0.71 | 0.89 | 0.67 | 0.00 | 1.00 |
| cloudflare/clef-flash | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.89 | 0.00 | 0.00 | – |
| cloudflare/clef-flash | score | 7.67 | 0.53 | 1.00 | 0.68 | 0.89 | 1.00 | 0.00 | 1.00 |
| liquid/d1 | choice-label | 10.33 | 0.38 | 1.00 | 0.54 | 1.00 | 3.00 | 0.00 | 0.96 |
| liquid/d1 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.89 | 0.00 | 0.00 | – |
| liquid/d1 | score | 10.33 | 0.38 | 1.00 | 0.54 | 0.89 | 3.00 | 0.00 | 1.00 |
| microsoft/microsoft-decision-1 | choice-label | 10.33 | 0.38 | 1.00 | 0.54 | 1.00 | 2.67 | 1.00 | 1.00 |
| microsoft/microsoft-decision-1 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 1.00 | 0.00 | 0.00 | – |
| microsoft/microsoft-decision-1 | score | 10.00 | 0.42 | 1.00 | 0.57 | 1.00 | 2.67 | 2.00 | 0.96 |
| perplexity/pplx-decider-v1.1-27b | choice-label | 12.00 | 0.28 | 0.89 | 0.42 | 0.78 | 6.00 | 12.00 | 1.00 |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1.00 | 0.33 | 0.08 | 0.13 | 0.25 | 0.67 | 1.00 | – |
| perplexity/pplx-decider-v1.1-27b | score | 12.00 | 0.31 | 1.00 | 0.47 | 0.89 | 5.33 | 12.00 | 1.00 |
| typesafe/jev-1.13 | choice-label | 11.67 | 0.32 | 1.00 | 0.48 | 0.94 | 3.67 | 0.00 | 0.96 |
| typesafe/jev-1.13 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.69 | 0.00 | 0.00 | – |
| typesafe/jev-1.13 | score | 11.67 | 0.32 | 1.00 | 0.48 | 1.00 | 3.67 | 1.00 | 1.00 |

Observations:

- **Recall is near-perfect, precision is low.** Both arms return the needed skills (the only miss is `node-api` for `payments-checkout` in per-skill choice with pplx, both trials), at the price of about 10 skills advertised on average where 3–4 are needed. In 20 of 40 score runs and 18 of 40 choice runs more than 12 skills were eligible, so the cap, not the threshold, decided the final list.
- **The unrelated control is where models differ.** Excluding pplx (which keeps 12 of a possible 22–25 on the control), unrelated picks averaged 0.75 for score (jev 1 and 1, microsoft 2 and 2, others 0) and 0.25 for per-skill choice (jev 0 and 0, microsoft 1 and 1, others 0).
- **Raw-score separation explains it.** For `typesafe/jev-1.13`, `liquid/d1`, `cloudflare/clef-flash` and `microsoft/microsoft-decision-1` the needed skills have median score ≈ 1.85–2.0 and non-required skills ≈ 0.07–0.35, so extra advertisements come from mid-score adjacent skills. For `perplexity/pplx-decider-v1.1-27b`, needed skills score 1.00–1.30 (median 1.16) against a non-required median of 0.91: almost everything sits near 1, so a 0.75 floor admits nearly all 30 skills.
- Same numbers without the cap (label floor `related` only):

| Model | Arm | selected (mean) | precision | recall | F1 | req@R | off-topic | unrelated picked | stability |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cloudflare/clef-flash | choice-label | 7.00 | 0.56 | 1.00 | 0.71 | 0.89 | 0.67 | 0.00 | 1.00 |
| cloudflare/clef-flash | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.89 | 0.00 | 0.00 | – |
| cloudflare/clef-flash | score | 7.67 | 0.53 | 1.00 | 0.68 | 0.89 | 1.00 | 0.00 | 1.00 |
| liquid/d1 | choice-label | 14.33 | 0.33 | 1.00 | 0.47 | 1.00 | 6.67 | 0.00 | 1.00 |
| liquid/d1 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.89 | 0.00 | 0.00 | – |
| liquid/d1 | score | 13.00 | 0.35 | 1.00 | 0.49 | 0.89 | 5.33 | 0.00 | 1.00 |
| microsoft/microsoft-decision-1 | choice-label | 11.50 | 0.36 | 1.00 | 0.51 | 1.00 | 3.83 | 1.00 | 0.98 |
| microsoft/microsoft-decision-1 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 1.00 | 0.00 | 0.00 | – |
| microsoft/microsoft-decision-1 | score | 12.00 | 0.38 | 1.00 | 0.52 | 1.00 | 4.67 | 2.00 | 0.97 |
| perplexity/pplx-decider-v1.1-27b | choice-label | 29.67 | 0.11 | 0.89 | 0.20 | 0.78 | 21.33 | 22.00 | 1.00 |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1.00 | 0.33 | 0.08 | 0.13 | 0.25 | 0.67 | 1.00 | – |
| perplexity/pplx-decider-v1.1-27b | score | 29.33 | 0.13 | 1.00 | 0.22 | 0.89 | 20.67 | 25.00 | 1.00 |
| typesafe/jev-1.13 | choice-label | 16.67 | 0.25 | 1.00 | 0.38 | 0.94 | 8.00 | 0.00 | 1.00 |
| typesafe/jev-1.13 | choice-shortlist | 1.00 | 1.00 | 0.28 | 0.43 | 0.69 | 0.00 | 0.00 | – |
| typesafe/jev-1.13 | score | 15.67 | 0.25 | 1.00 | 0.40 | 1.00 | 7.00 | 1.00 | 1.00 |

### 5. Choice vs score: the same answer under two policies

Using **all** recorded choice-arm verdicts, compare the deployed argmax label rule with a score-style threshold on that same answer's recorded derived value (`2·p(direct) + p(related)` when a distribution came back, else the hard-label index 0/1/2) against 0.75 / 1.5. The raw report stores that derived value, **not** the distributions, so the “non-integer derived score” column counts values with a fractional part only: it is **not** a count of answers that carried a distribution, and an integer value does not mean the distribution was missing (a distribution of `[.4, .2, .4]` has expectation exactly 1 while its argmax label is irrelevant or directly relevant, and such cases are included in the disagreement counts):

| Model | choice items | non-integer derived score | label differs from 0.75/1.5 threshold label | eligibility differs (argmax vs score>=0.75) | eligible by argmax only | eligible by threshold only |
|---|---:|---:|---:|---:|---:|---:|
| typesafe/jev-1.13 | 240 | 154 | 16 | 15 | 15 | 0 |
| perplexity/pplx-decider-v1.1-27b | 240 | 240 | 20 | 12 | 10 | 2 |
| cloudflare/clef-flash | 240 | 240 | 6 | 2 | 0 | 2 |
| liquid/d1 | 240 | 240 | 27 | 7 | 1 | 6 |
| microsoft/microsoft-decision-1 | 240 | 240 | 13 | 11 | 10 | 1 |

Argmax and thresholded expectation disagree on the **label** for 6–27 of 240 verdicts, and on **eligibility** (related-or-better) for 2–15 per model, in both directions: `jev-1.13`, `pplx` and `microsoft` mostly have argmax-eligible skills whose expectation falls under 0.75 (a “related”-or-better most-likely label with an expectation under 0.75 implies substantial probability on “irrelevant”), while `liquid/d1` and `clef-flash` mostly have the opposite. This confirms in data what the arithmetic predicts: the two rules are different policies, not one policy in two formats.

### 6. Do the two per-skill arms pick the same skills? Repeat stability

Selection agreement is measured on the production result (cap 12), paired by model, task and trial; the second table is the single-winner arm. Stability columns in the per-model table above are trial-to-trial Jaccard (0.96–1.00 for both methods; a few cells for jev, liquid and microsoft changed between trials, the rest were identical).

| Model | paired runs | selection Jaccard (score vs choice-label) | same selected count |
|---|---:|---:|---:|
| typesafe/jev-1.13 | 8 | 0.70 | 6/8 |
| perplexity/pplx-decider-v1.1-27b | 8 | 0.46 | 8/8 |
| cloudflare/clef-flash | 8 | 0.96 | 6/8 |
| liquid/d1 | 8 | 0.91 | 8/8 |
| microsoft/microsoft-decision-1 | 8 | 0.82 | 4/8 |

| Model | shortlist hit@1 (required winner) | max possible recall (1 / number of required skills) | none on unrelated | probabilities returned |
|---|---:|---:|---:|---|
| typesafe/jev-1.13 | 1.00 | 0.28 | 1.00 | yes |
| perplexity/pplx-decider-v1.1-27b | 0.33 | 0.28 | 0.00 | yes |
| cloudflare/clef-flash | 1.00 | 0.28 | 1.00 | yes |
| liquid/d1 | 1.00 | 0.28 | 1.00 | yes |
| microsoft/microsoft-decision-1 | 1.00 | 0.28 | 1.00 | yes |

Score and per-skill choice agree closely for `cloudflare/clef-flash` (Jaccard 0.96) and `liquid/d1` (0.91) and much less for `pplx` (0.46; plausibly because the cap chooses among many near-tied scores — not tested) and `jev-1.13` (0.70). Different questions to a model are different samples, so agreement is bounded by model behavior, not only by method.

### 7. Single-winner choice

- Winner was a needed skill in 12 of 12 positive runs for four models, but only 1 of 3 for pplx (it picked `form-validation` for the payments and Kubernetes tasks and `browser-testing` for the control).
- Because a single question yields one winner, recall is capped at 1/|required|: mean ceiling **0.28** on these tasks (1/4, 1/3, 1/4); observed mean recall **0.24**. Precision was high (pooled 0.87) simply because only one skill was kept.
- It correctly chose `none` for the control on 4 of 5 models.
- Option probabilities were returned on 20/20 calls. A top-K from them would be a *different, not deployed* selector (a distribution among competing skills), and was not evaluated as a policy.

### 8. Exploratory post-hoc threshold analysis (NOT a rerunnable policy)

> Everything in this section was computed **after** viewing the results by re-thresholding the recorded raw per-skill scores; **no extra requests were made**, and none of these settings was used in the live calls. Thresholds were picked from a five-point grid **in-sample**, so any “best” value is optimistic. The choice-arm numbers use the derived expectation `2·p(direct) + p(related)` (hard label 0/1/2 when no distribution), i.e. a policy that is **not** how choice mode currently selects. Selection is uncapped.

| Arm | min score | selected (mean) | precision | recall | F1 | off-topic | unrelated picked |
|---|---:|---:|---:|---:|---:|---:|---:|
| score | 0.75 | 15.53 | 0.33 | 1.00 | 0.46 | 7.73 | 5.60 |
| score | 1 | 8.17 | 0.56 | 1.00 | 0.68 | 2.10 | 0.50 |
| score | 1.25 | 5.20 | 0.70 | 0.81 | 0.67 | 0.83 | 0.20 |
| score | 1.5 | 3.60 | 0.68 | 0.76 | 0.70 | 0.17 | 0.00 |
| score | 1.75 | 2.80 | 0.76 | 0.71 | 0.72 | 0.00 | 0.00 |
| choice-label | 0.75 | 15.10 | 0.34 | 1.00 | 0.48 | 7.40 | 4.30 |
| choice-label | 1 | 8.40 | 0.54 | 0.96 | 0.65 | 2.40 | 0.60 |
| choice-label | 1.25 | 5.10 | 0.66 | 0.81 | 0.68 | 0.93 | 0.00 |
| choice-label | 1.5 | 3.63 | 0.67 | 0.73 | 0.67 | 0.43 | 0.00 |
| choice-label | 1.75 | 2.93 | 0.74 | 0.73 | 0.72 | 0.00 | 0.00 |

| Model | Arm | F1 @0.75 | F1 @1 | F1 @1.25 | F1 @1.5 | F1 @1.75 | unrel @0.75 | unrel @1 | unrel @1.25 | unrel @1.5 | unrel @1.75 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typesafe/jev-1.13 | score | 0.40 | 0.51 | 0.62 | 0.77 | 0.88 | 1.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| typesafe/jev-1.13 | choice-label | 0.43 | 0.53 | 0.73 | 0.85 | 0.92 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| perplexity/pplx-decider-v1.1-27b | score | 0.22 | 0.81 | 0.27 | 0.00 | 0.00 | 25.0 | 1.0 | 0.0 | 0.0 | 0.0 |
| perplexity/pplx-decider-v1.1-27b | choice-label | 0.22 | 0.72 | 0.22 | 0.00 | 0.00 | 20.0 | 2.0 | 0.0 | 0.0 | 0.0 |
| cloudflare/clef-flash | score | 0.68 | 0.86 | 0.93 | 0.89 | 0.82 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| cloudflare/clef-flash | choice-label | 0.69 | 0.82 | 0.93 | 0.82 | 0.82 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| liquid/d1 | score | 0.49 | 0.54 | 0.67 | 0.84 | 0.93 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| liquid/d1 | choice-label | 0.43 | 0.48 | 0.57 | 0.72 | 0.92 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| microsoft/microsoft-decision-1 | score | 0.52 | 0.69 | 0.86 | 1.00 | 0.95 | 2.0 | 1.5 | 1.0 | 0.0 | 0.0 |
| microsoft/microsoft-decision-1 | choice-label | 0.59 | 0.69 | 0.96 | 0.95 | 0.95 | 1.5 | 1.0 | 0.0 | 0.0 | 0.0 |

What the sweep shows, and does not show:

- Raising the floor from 0.75 trades recall for precision for both arms in a similar way; pooled F1 is 0.46–0.48 at 0.75, 0.65–0.68 at 1.0, 0.67–0.70 at 1.25–1.5 and 0.72 at 1.75 in both arms.
- The shape is model-specific: pplx peaks around 1.0 (F1 0.81 score / 0.72 choice) and has **no** needed skill reaching 1.5 (F1 0.00 there; needed skills scored 0.98–1.37), whereas jev and liquid keep improving to 1.75, microsoft peaks at 1.5 (score) or 1.25–1.75 (choice), and clef-flash peaks at 1.25. A single global threshold would be wrong for at least one of these five models.
- These are not recommended settings. A usable calibration needs labeled tasks that are held out from the threshold search, per model, rubric and model version.

## Interpretation (research plus measurements)

1. **Both deployed methods are per-skill, three-level relevance judgments**, so both can keep zero, one or many skills. The real difference is the shape of the answer: a label chosen by argmax (`choice`) vs an expectation (`score`). Score thresholds are raw 0–2 rubric indices applied locally; they are not probabilities or confidence.
2. **Score keeps its default role** for ranked, thresholded, budget-capped advertisement: it always provides a fractional rank, whereas per-skill choice can rank finely only when the provider returns a distribution. The recorded derived value was non-integer for 240 of 240 verdicts for four models and for 154 of 240 for `jev-1.13`; the integer remainder cannot be classified from the stored data, but any ties between integer values are broken by inventory order under the cap. Use per-skill choice when the policy really is “keep what the model categorizes as at least related”.
3. **Neither is intrinsically a list picker.** One choice question over all skills is exclusive within that question, not an independent usefulness estimate per skill; the measured recall ceiling above is the practical consequence.
4. **Model and threshold calibration matter more than method** in this sample. Do not switch defaults because one setup advertises fewer skills (a missed needed skill is a false negative; the cap can hide eligibility differences).

## Limitations

- 4 tasks (3 positive), 2 repeats, 5 models, 100 requests; **no statistical conclusions**. Means over 8 or 30 observations are shown for description.
- One annotator and subjective `acceptable` sets; the demo's skill descriptions overlap. The control is a single task.
- Not tested: other rubric wordings (including more concrete independent level text), other batch sizes (all 30 in one call), chunked parallel batches, task wording variants, long or ambiguous prompts, the full `before_agent_start` hook, pins, other inventories, the three models not benchmarked, or downstream task success.
- Latency: one machine and network path, sequential calls, process-wide keep-alive connection reuse (not separately verified), the first call per model included, two arm orders only. Provider-side load and routing vary by time of day; all 100 requests started between 12:01:06 and 12:02:09 UTC on 2026-10-13.
- Costs are provider-reported `usage.cost`, not reconciled billing.
- `req@R` ties are resolved against the arm; the post-hoc sweep is in-sample.
- The raw report header originally recorded a three-value threshold-sweep list; it was removed before publication because the analysis grid was widened after the run (measurements were not edited).

## Appendix A — every selection, by task, model and method

`eligible uncapped` = skills at or above the `related` label floor; `kept (cap 12)` = the deployed result (listed names, sorted, are for trial 1; the last column shows the trial 2 difference as `+added` / `-removed`). For the single-winner arm, the count is 1 and the name is the returned winner (`none` ⇒ empty). Trials 1 and 2 are shown as `t1/t2`.

### react-signup

Required: react-components, web-accessibility, form-validation, browser-testing. Acceptable: authentication, typescript-types, unit-testing, css-layout, product-copy, security-review.

| Model | Arm | eligible uncapped t1/t2 | kept (cap 12) t1/t2 | kept names, trial 1 | trial 2 differs by |
|---|---|---:|---:|---|---|
| typesafe/jev-1.13 | score | 16/16 | 12/12 | authentication, browser-testing, css-layout, form-validation, github-actions, product-copy, react-components, security-review, test-data, typescript-types, unit-testing, web-accessibility | identical |
| typesafe/jev-1.13 | choice-label | 17/17 | 12/12 | authentication, browser-testing, css-layout, form-validation, github-actions, product-copy, react-components, security-review, test-data, typescript-types, unit-testing, web-accessibility | identical |
| typesafe/jev-1.13 | choice-shortlist | 1 | 1 | react-components | n/a |
| perplexity/pplx-decider-v1.1-27b | score | 30/30 | 12/12 | authentication, browser-testing, email-delivery, form-validation, git-workflows, graphql-schema, product-copy, react-components, test-data, typescript-types, unit-testing, web-accessibility | identical |
| perplexity/pplx-decider-v1.1-27b | choice-label | 30/30 | 12/12 | authentication, browser-testing, css-layout, database-migrations, email-delivery, form-validation, github-actions, graphql-schema, product-copy, react-components, test-data, web-accessibility | identical |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1 | 1 | form-validation | n/a |
| cloudflare/clef-flash | score | 12/12 | 12/12 | authentication, browser-testing, css-layout, form-validation, node-api, product-copy, python-testing, react-components, security-review, typescript-types, unit-testing, web-accessibility | identical |
| cloudflare/clef-flash | choice-label | 10/10 | 10/10 | authentication, browser-testing, css-layout, form-validation, node-api, react-components, security-review, typescript-types, unit-testing, web-accessibility | identical |
| cloudflare/clef-flash | choice-shortlist | 1 | 1 | browser-testing | n/a |
| liquid/d1 | score | 13/13 | 12/12 | browser-testing, css-layout, design-tokens, form-validation, github-actions, product-copy, react-components, security-review, test-data, typescript-types, unit-testing, web-accessibility | identical |
| liquid/d1 | choice-label | 14/14 | 12/12 | authentication, browser-testing, css-layout, design-tokens, form-validation, github-actions, product-copy, react-components, test-data, typescript-types, unit-testing, web-accessibility | identical |
| liquid/d1 | choice-shortlist | 1 | 1 | browser-testing | n/a |
| microsoft/microsoft-decision-1 | score | 16/16 | 12/12 | authentication, browser-testing, css-layout, form-validation, github-actions, product-copy, react-components, security-review, test-data, typescript-types, unit-testing, web-accessibility | identical |
| microsoft/microsoft-decision-1 | choice-label | 16/15 | 12/12 | authentication, browser-testing, css-layout, form-validation, github-actions, product-copy, react-components, security-review, test-data, typescript-types, unit-testing, web-accessibility | identical |
| microsoft/microsoft-decision-1 | choice-shortlist | 1 | 1 | browser-testing | n/a |

### payments-checkout

Required: payments, email-delivery, node-api. Acceptable: security-review, api-contracts, redis-cache, authentication, unit-testing.

| Model | Arm | eligible uncapped t1/t2 | kept (cap 12) t1/t2 | kept names, trial 1 | trial 2 differs by |
|---|---|---:|---:|---|---|
| typesafe/jev-1.13 | score | 20/20 | 12/12 | api-contracts, database-migrations, email-delivery, node-api, observability, payments, postgres-queries, security-review, technical-docs, test-data, typescript-types, unit-testing | identical |
| typesafe/jev-1.13 | choice-label | 22/22 | 12/12 | api-contracts, database-migrations, email-delivery, node-api, observability, payments, postgres-queries, product-copy, react-components, security-review, technical-docs, unit-testing | +typescript-types, -product-copy |
| typesafe/jev-1.13 | choice-shortlist | 1 | 1 | payments | n/a |
| perplexity/pplx-decider-v1.1-27b | score | 30/30 | 12/12 | design-tokens, docker-containers, email-delivery, node-api, observability, payments, product-copy, python-testing, security-review, technical-docs, typescript-types, web-accessibility | identical |
| perplexity/pplx-decider-v1.1-27b | choice-label | 29/29 | 12/12 | api-contracts, css-layout, database-migrations, email-delivery, observability, payments, postgres-queries, python-testing, react-components, redis-cache, security-review, typescript-types | identical |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1 | 1 | form-validation | n/a |
| cloudflare/clef-flash | score | 5/5 | 5/5 | email-delivery, form-validation, node-api, payments, security-review | identical |
| cloudflare/clef-flash | choice-label | 5/5 | 5/5 | email-delivery, form-validation, node-api, payments, security-review | identical |
| cloudflare/clef-flash | choice-shortlist | 1 | 1 | payments | n/a |
| liquid/d1 | score | 19/19 | 12/12 | api-contracts, database-migrations, email-delivery, form-validation, node-api, observability, payments, react-components, redis-cache, security-review, technical-docs, unit-testing | identical |
| liquid/d1 | choice-label | 22/22 | 12/12 | api-contracts, css-layout, database-migrations, email-delivery, form-validation, node-api, payments, react-components, redis-cache, security-review, technical-docs, unit-testing | +product-copy, -technical-docs |
| liquid/d1 | choice-shortlist | 1 | 1 | payments | n/a |
| microsoft/microsoft-decision-1 | score | 15/13 | 12/12 | api-contracts, email-delivery, form-validation, node-api, observability, payments, product-copy, react-components, security-review, typescript-types, unit-testing, web-accessibility | +test-data, -product-copy |
| microsoft/microsoft-decision-1 | choice-label | 12/12 | 12/12 | api-contracts, email-delivery, form-validation, node-api, observability, payments, product-copy, react-components, security-review, typescript-types, unit-testing, web-accessibility | identical |
| microsoft/microsoft-decision-1 | choice-shortlist | 1 | 1 | payments | n/a |

### k8s-deploy

Required: docker-containers, kubernetes-deploy, github-actions, observability. Acceptable: terraform-infra, incident-response, git-workflows, security-review.

| Model | Arm | eligible uncapped t1/t2 | kept (cap 12) t1/t2 | kept names, trial 1 | trial 2 differs by |
|---|---|---:|---:|---|---|
| typesafe/jev-1.13 | score | 11/11 | 11/11 | docker-containers, git-workflows, github-actions, incident-response, kubernetes-deploy, node-api, observability, security-review, technical-docs, terraform-infra, unit-testing | identical |
| typesafe/jev-1.13 | choice-label | 11/11 | 11/11 | docker-containers, git-workflows, github-actions, incident-response, kubernetes-deploy, node-api, observability, security-review, technical-docs, terraform-infra, unit-testing | identical |
| typesafe/jev-1.13 | choice-shortlist | 1 | 1 | kubernetes-deploy | n/a |
| perplexity/pplx-decider-v1.1-27b | score | 28/28 | 12/12 | browser-testing, docker-containers, git-workflows, github-actions, incident-response, kubernetes-deploy, observability, python-testing, security-review, terraform-infra, test-data, unit-testing | identical |
| perplexity/pplx-decider-v1.1-27b | choice-label | 30/30 | 12/12 | api-contracts, docker-containers, git-workflows, github-actions, kubernetes-deploy, node-api, observability, postgres-queries, python-testing, redis-cache, terraform-infra, unit-testing | identical |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1 | 1 | form-validation | n/a |
| cloudflare/clef-flash | score | 6/6 | 6/6 | docker-containers, git-workflows, github-actions, kubernetes-deploy, observability, terraform-infra | identical |
| cloudflare/clef-flash | choice-label | 6/6 | 6/6 | docker-containers, git-workflows, github-actions, kubernetes-deploy, observability, terraform-infra | identical |
| cloudflare/clef-flash | choice-shortlist | 1 | 1 | kubernetes-deploy | n/a |
| liquid/d1 | score | 7/7 | 7/7 | docker-containers, git-workflows, github-actions, kubernetes-deploy, observability, security-review, technical-docs | identical |
| liquid/d1 | choice-label | 7/7 | 7/7 | docker-containers, git-workflows, github-actions, kubernetes-deploy, observability, security-review, technical-docs | identical |
| liquid/d1 | choice-shortlist | 1 | 1 | kubernetes-deploy | n/a |
| microsoft/microsoft-decision-1 | score | 6/6 | 6/6 | docker-containers, git-workflows, github-actions, kubernetes-deploy, observability, security-review | identical |
| microsoft/microsoft-decision-1 | choice-label | 7/7 | 7/7 | docker-containers, git-workflows, github-actions, incident-response, kubernetes-deploy, observability, security-review | identical |
| microsoft/microsoft-decision-1 | choice-shortlist | 1 | 1 | kubernetes-deploy | n/a |

### unrelated-eclipse

Required: none. Acceptable: none.

| Model | Arm | eligible uncapped t1/t2 | kept (cap 12) t1/t2 | kept names, trial 1 | trial 2 differs by |
|---|---|---:|---:|---|---|
| typesafe/jev-1.13 | score | 1/1 | 1/1 | product-copy | identical |
| typesafe/jev-1.13 | choice-label | 0/0 | 0/0 | none | identical |
| typesafe/jev-1.13 | choice-shortlist | 0 | 0 | none | n/a |
| perplexity/pplx-decider-v1.1-27b | score | 25/25 | 12/12 | api-contracts, browser-testing, design-tokens, github-actions, incident-response, kubernetes-deploy, node-api, postgres-queries, product-copy, technical-docs, test-data, web-accessibility | identical |
| perplexity/pplx-decider-v1.1-27b | choice-label | 22/22 | 12/12 | api-contracts, authentication, database-migrations, design-tokens, git-workflows, github-actions, kubernetes-deploy, postgres-queries, product-copy, python-data, technical-docs, terraform-infra | identical |
| perplexity/pplx-decider-v1.1-27b | choice-shortlist | 1 | 1 | browser-testing | n/a |
| cloudflare/clef-flash | score | 0/0 | 0/0 | none | identical |
| cloudflare/clef-flash | choice-label | 0/0 | 0/0 | none | identical |
| cloudflare/clef-flash | choice-shortlist | 0 | 0 | none | n/a |
| liquid/d1 | score | 0/0 | 0/0 | none | identical |
| liquid/d1 | choice-label | 0/0 | 0/0 | none | identical |
| liquid/d1 | choice-shortlist | 0 | 0 | none | n/a |
| microsoft/microsoft-decision-1 | score | 2/2 | 2/2 | product-copy, technical-docs | identical |
| microsoft/microsoft-decision-1 | choice-label | 1/1 | 1/1 | technical-docs | identical |
| microsoft/microsoft-decision-1 | choice-shortlist | 0 | 0 | none | n/a |

## Appendix B — artifacts

| Artifact | Purpose |
|---|---|
| `docs/benchmarks/relevance-methods-raw.json` | Every record: per-skill raw scores and labels for all 30 candidates, selected names, timing phases, physical requests, HTTP statuses, request bytes, usage and cost. No credentials or provider error bodies |
| `scripts/benchmark-relevance-methods.ts` | Opt-in benchmark and offline summarizer (default checks make no network calls) |
| `examples/skill-picker-demo/benchmark-cases.json` | Tasks and labels |
| `test/benchmark-relevance-methods.test.ts` | Offline tests for the benchmark (fake clients; gate, budget, resume, metrics, rendering) |
| `.agents/research/choice-score-skill-selection-2026-10-13.md` | Semantics research and fair-benchmark protocol |
