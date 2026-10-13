# Choice versus score for metadata-only skill advertisements

Research date/access date: **2026-10-13 UTC**. Local baseline: `9b1796c04f9fdefce756e571e58b7c1bd3aec859` (v0.2.0); installed Pi AI/coding-agent **1.1.0**. Neighbor reference: `../pi-skill-picker-jev` at `691f456b59032be656422ab998ccb98c6e6fada5`. This is a uniquely named follow-up, not an amendment to archived provider research. Live benchmark measurements belong in the separate `docs/` benchmark report; this research unit made **no inference calls**, installed nothing, and ran no tests.

## Recommendation

**Retain per-skill `score` as the default for thresholded, budget-capped advertisement ranking.** Relevance has a natural ordering, and the application must rank several useful skills, not route to one mutually exclusive skill. Use **per-skill `choice`** when a literal categorical verdict is the desired policy: irrelevant / related / directly relevant. Neither API is intrinsically a multi-select list picker, and the existing choice implementation is already suitable for selecting several skills because it asks a separate question for each skill. This is a task-fit recommendation, **not a measured accuracy or latency claim**. [L1][L2][T1][O1]

Do not switch defaults solely because a model selects fewer advertisements: omission of needed skills is a false negative, whereas unwanted advertisements are false positives/context overhead. A cap masks differences in eligibility. Choose the model and threshold with labeled task examples and a held-out set, then account for latency, failures and billed usage. OpenAI explicitly recommends application labels and thresholds based on false-positive/false-negative costs. [O1: Interpret the answers]

## Exact semantics

| Aspect | `choice` | `score` |
| --- | --- | --- |
| Primitive result | One supplied label per question; TypeSafe specifies highest probability | Probability-weighted mean of zero-based ordered level indices |
| Current questions | One question per skill, each with three labels | One question per skill, each with three ordered levels |
| Eligibility | Returned label meets `minLabel`; score thresholds do **not** relabel it | Expected score meets configured inclusive threshold and resulting label meets `minLabel` |
| Rank within eligible skills | `2*p(directly_relevant)+p(related)` if distribution is present; otherwise hard label maps to 2/1/0 | Returned scalar expected index |
| Meaning of `normalized` | That ranking value divided by 2 | Expected index divided by 2 |
| Missing distributions | Supported by direct OpenRouter; causes tied hard-label ranks | Scalar still provides fractional rank |

Implementation: `src/apps/relevance.ts:109-139,142-179`; filter: `src/apps/skill-filter.ts:36-67`. Tests demonstrating intended interpretation: `test/relevance.test.ts` tests “fractional score is expectation…” and “choice gives exact label…”. These were inspected, **not executed by this researcher**. [L1][L2]

### Exclusivity is within a question, not across skills

A single choice question whose options are all 30 skill names forces a winner (unless a `none` option is added); its distribution is among competing skill options. That is not an estimate of independent usefulness for each skill, and taking top K probabilities does not make it equivalent to the deployed selector. Several skills may be useful simultaneously. Current code avoids this by making 30 separate relevance questions, each selecting one of three relevance classes. Both deployed modes can therefore keep **zero, one or many** skills. [L1][T2][O1]

TypeSafe documents questions as independently evaluated against shared state; its score guide additionally says **each level is judged separately**, without its numeric index or neighboring levels. These are two different meanings of “independent.” The latter requires each criterion to be independently understandable (not “better than previous” or just “0/1/2”). Within the returned answer, level probabilities still form a distribution summing to one, **not independent multi-label Bernoulli probabilities**. Do not generalize TypeSafe's internal execution design to every OpenRouter-routed model without evidence. [T1][T3][T4]

### Expected value is not a probability, category, or confidence

For the present levels 0=irrelevant, 1=related, 2=directly relevant:

`score = p(related) + 2*p(directly_relevant)`; `normalized = score/2`.

A score of 1 can mean certainty at “related” or a 50/50 split between irrelevant and directly relevant. Thus neither `score >= 1` nor `normalized >= .5` means “at least 50% probability directly relevant.” Converting score to a label is local threshold policy, not the provider selecting a class. TypeSafe's score guide explicitly illustrates this loss of distribution information. [T3: Reading a Score][L1]

Choice and score can disagree even given **identical probabilities**. With `[irrelevant=.40, related=.35, direct=.25]`, choice is irrelevant, while the expectation `.85` passes the extension's default related threshold `.75`. This is arithmetic, not an observed benchmark example. Conversely `[.35,.20,.45]` chooses directly relevant but its expectation is only 1.10, below the extension's direct threshold 1.5. No universal score threshold reproduces a three-way argmax rule. Also, choice option names are semantic input in TypeSafe whereas score numeric indices are not; an identical rubric description alone does not prove identical inference distributions. [T2: Request structure][T3: Levels][L1]

Confidence summarizes distribution concentration, not usefulness or a guarantee of correctness. TypeSafe defines different concentration formulas for ordered score versus unordered choice. A confident irrelevant answer is still irrelevant; multiplying relevance by confidence changes policy and is not part of this implementation. Do not compare raw confidence values across models/types as calibrated correctness without application evaluation. [T5][L1]

## Current application limits and behavior

- Defaults: score mode; rubric “task”; thresholds **.75 / 1.5 raw**; task 4000 characters; description 400; name 64; state 65536 serialized characters; inventory at most 1000; batch size and local maximum questions 50; concurrency 0 means all batches parallel; whole-operation deadline 8000ms. These are **application safety/configuration defaults**, not verified universal provider limits. [L1:40-47,63-78]
- Questions point at `state.skills.sN`; prompt and metadata are data, not executable instructions. Only bounded task/name/description are sent—no skill bodies, paths or transcript. IDs are chunk-local and mapped back to original names. Duplicates first-win. Batch splits honor question count and serialized state size; `rankSkills` also reduces to a declared client cap. All candidates are evaluated, not only the first chunk. [L1:80-139,182-239]
- The filter gates labels, sorts descending expected score with stable tie order, applies **maxSkills default 12**, then returns original references/inventory order. Pins and manual-only entries survive outside the scored cap; pins bypass scoring. Invalid/missing batch answers fail closed by default. Disabled, unconfigured, empty-task or below-minimum filtering intentionally skips; automatic inventory minimum defaults to 8, explicit `pickSkills` to 0. [L2:36-78,111-155]
- Actual extension hook passes the configured mode/settings and changes only `systemPromptOptions.skills`; later extensions can overwrite them. This is **advertisement reduction, not authorization/access control**. [L3:116-178]
- TypeSafe direct adapter enforces **255 choice options / 10 score levels** and strict metadata. Current task uses only three options/levels; those limits are not a 255-skill or 10-skill cap when asking one question per skill. OpenRouter direct accepts optional distributions/confidence/legend; Pi's installed System One parser requires choice distribution/confidence and score confidence, and drops score distributions. Do not mistake the native Pi parser's stricter surface for direct OpenRouter's schema. [L4][P1][R1]
- Portable validation checks exact answer IDs, finite score range, complete provided distributions summing to one within tolerance, and score agreement with distribution. TypeSafe additionally checks choice agrees with the highest probability; direct OpenRouter is deliberately tolerant about that provider-specific guarantee. [L5:104-158][L4]

### The demos are not identical policies

This repo contains exactly 30 demo skills. `scripts/demo-skill-picker.ts:191-210` loads metadata, calls the public picker in **score mode only**, with batch10/concurrency2/cap6/default normalized threshold .5 (**raw1**), direct threshold2. It does not expose mode or measure end-to-end time. Reuse `loadDemoSkills` with `pickSkills({mode})` for a paired method benchmark; do not treat the lexical mock as model evidence. [L6]

Neighbor `src/picker.ts:36-65,86-139,142-187` uses **five concrete levels**, normalizes by 4, embeds skill metadata in question instructions, accepts longer descriptions/task text, includes `already_available` in state, uses up to six concurrent batches and a cap on newly advertised skills. Its results cannot be pooled as an apples-to-apples 3-level method comparison without controlling those differences. Same normalized threshold does not preserve meaning across different rubric definitions. [N1]

## Fair benchmark and calibration protocol

1. Run at least five distinct retained OpenRouter model IDs via the **same direct decisions endpoint**, not different chat prompts or native Pi wrappers. Record request model and actual response build/provider; listing or historical smoke success is not proof of current account availability.
2. Use this repo's same 30 metadata entries, task rubric/instructions, metadata truncation, batches, concurrency, timeouts, cap, eligibility floor and retry policy for both methods. Record exact options and fixture provenance/hash. Alternate method order/repetitions to reduce cold-start/order effects; this is still a small network snapshot, not a controlled provider speed trial.
3. Report both **uncapped eligible count** and **capped selected count/names**, per-skill raw values/labels, distributions when available, request count/batch sizes, safe error code, successful-run count and failure count. Fail-closed with zero retained advertisements is **not** successful irrelevance detection.
4. Time wall-clock from entry to the picker until validated final selection (batch building, authentication, transport, parsing, eligibility and ranking included). Separately record metadata load/client initialization if excluded. Whole agent/chat execution, downstream skill-body loading and task completion are **not** benchmarked; label this as picker end-to-end rather than full-agent end-to-end.
5. Use several tasks: clear frontend multi-skill, distinct database/backend domain, mixed task, and no-relevant-skill control. At least two repeats allow range/median and selection stability but cannot support meaningful tail-latency or general accuracy claims. Include failures, avoid synthetic p95 conclusions from a handful of runs.
6. Compare the two deployed policies first. Optionally derive a separate expectation-threshold policy from choice distributions offline: this isolates postprocessing somewhat but must be labeled **not current choice behavior**, and differing question formats may still change predictions. Do not perform more paid calls merely to vary thresholds when per-skill outputs can be replayed.
7. For true quality, predefine relevance labels or must-have/optional sets **before viewing outputs**, then evaluate held-out examples using needed-skill recall, advertisement precision, ranking/top-K recall, false-positive/false-negative rates and downstream task success. Demo illustrative selections and mock token matches are not expert ground truth. Tune thresholds per model/rubric/version; changing all three at once prevents attributing improvements to the method. Negative-control leakage and repeats are useful diagnostics, not sufficient calibration.

## Sources retrieved and inspected

Primary web sources accessed **2026-10-13 UTC**. Their fetched documentation supplied no publication date; do not infer one. Search used Exa to discover primary pages, then official HTTP markdown/raw sources were read. Third-party `jevtypesafeai.com` search hits were **not relied upon**. A guessed `/score.md` returned 404; the correct `/primitives/score.md` was subsequently retrieved. No credentials were needed for retrieval.

- **T1:** TypeSafe [API reference](https://docs.typesafe.ai/api.md), Question types / Answer types: one option, highest probability, maximum255; probability-weighted score, 2–10 levels.
- **T2:** TypeSafe [Choice](https://docs.typesafe.ai/primitives/choice.md), Request structure / Response structure / Good practice: semantic option names, highest probability, batching and fallback options. Response-time statements are **vendor claims**, not our measurements.
- **T3:** TypeSafe [Score](https://docs.typesafe.ai/primitives/score.md), Levels / Reading a Score / Writing good levels / Structured level descriptions: index/expectation, independent descriptions, one dimension, and held-out examples rather than confidence as truth.
- **T4:** TypeSafe [State](https://docs.typesafe.ai/concepts/state.md) and [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), state independence and parallel composability; internal independence/self-consistency/speed/calibration are documented **vendor claims**, not independently proven here.
- **T5:** TypeSafe [Confidence](https://docs.typesafe.ai/confidence.md), How confidence is calculated: formulas differ for score/choice, concentration alone is not correctness.
- **O1:** OpenAI [Decisions guide](https://developers.openai.com/api/docs/guides/decisions.md), Choose a question type / Score against a rubric / Ask multiple questions / Interpret the answers: unordered choice vs ordered score, zero-based expectation, independent shared-input questions, application calibration. Guide currently says public beta and gpt-6-luna only on direct OpenAI; **not a claim that OpenRouter supports only Luna**.
- **R1:** Official OpenRouterTeam [Decisions reference](https://github.com/OpenRouterTeam/skills/blob/33597a44e38b0cdc38ea1256ef8bcf50c2704e3d/skills/openrouter-decisions/references/decisions-api.md#L3-L79), pinned commit `33597a44e38b0cdc38ea1256ef8bcf50c2704e3d`, request and optional metadata response rules.
- **P1:** Installed Pi 1.1.0 `node_modules/@earendil-works/pi-coding-agent/docs/models.md` and `docs/codemode.md` **read in full**; classifier section and Classify declaration. Linked implementations inspected: `node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js:10-66` and `openai-decisions.js:21-41,86-107`.
- **L1:** `src/apps/relevance.ts:40-47,80-239` at baseline commit.
- **L2:** `src/apps/skill-filter.ts:36-78,111-155` at baseline commit.
- **L3:** `src/extension/runtime.ts:116-178` at baseline commit.
- **L4:** `src/core/codecs/system-one.ts:14-46`; `src/core/backends/typesafe.ts:6-7`; `src/core/backends/openrouter.ts:4-5` at baseline commit.
- **L5:** `src/decision/validation.ts:104-176` at baseline commit; `test/relevance.test.ts`, `test/skill-filter.test.ts` inspected as intended-behavior evidence.
- **L6:** `scripts/demo-skill-picker.ts:42-44,91-106,116-119,191-210`; `examples/skill-picker-demo/README.md` at baseline commit.
- **N1:** Neighbor `src/picker.ts:36-65,86-139,142-187` at pinned reference commit.

Remaining gaps: no broad held-out relevance dataset, no independent validation of vendor calibration claims, no evidence of question/batch invariance across every routed model, no provider-wide guaranteed question-count limit established, and no proof that metadata-only selection improves downstream task completion. Network timings must come from the paired live benchmark, not these docs or remembered model rankings.
