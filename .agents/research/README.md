# Archived research and validation evidence

These dated documents preserve provider/API evidence, catalog provenance, and live-validation results. They are **historical records, not pending implementation plans**. Their contents are unchanged from the former `.agents/plans/` location; references to that layout or retired handoffs describe the repository at the time of research. Retired handoffs remain available in Git history.

- [Tool/MCP filtering: Pi 1.1.0 public contracts, 2026-10-13](tool-mcp-public-contracts-2026-10-13.md): installed-host evidence for declaration filtering, call gating, MCP identity and the public-API gaps.
- [Tool/MCP filtering design handoff, 2026-10-13](tool-mcp-filtering-design-2026-10-13.md): the architect's original design (archived, implemented; deviations listed at the top).
- [Direct provider research](direct-provider-research.md): TypeSafe, OpenAI, and OpenRouter protocol contracts and sources.
- [Pi integration research](pi-integration-research.md): Pi 1.1.0 host APIs, especially the tool/MCP visibility limits referenced by the pending plan.
- [OpenRouter weekly popularity](openrouter-weekly-popularity.md): the original top-ten snapshot and token-ranking provenance.
- [Live provider validation, 2026-10-12](live-provider-validation-2026-10-12.md): account-specific routing checks explaining the eight retained OpenRouter models.
- [Direct OpenAI with Pi credentials, 2026-10-12](live-openai-pi-credentials-2026-10-12.md): completed source-aware credential integration and bounded Luna smoke validation.

Current behavior is documented in [README.md](../../README.md) and [AGENTS.md](../../AGENTS.md), and verified by `src/` and `test/`. It supersedes historical dynamic-discovery, fail-open-default, public `noul`, old command-name, and env-only smoke proposals. Runtime discovery is absent; the catalog is static, filtering defaults to fail closed, the public primitive is `bool`, the command is `/decisions`, and smoke credentials are Pi-first/env-second. Historical unverified checks or pending test reruns are not current repository status.

No implementation handoff is pending. Opt-in tool/MCP filtering is implemented; its evidence is [Tool/MCP filtering: Pi 1.1.0 public contracts](tool-mcp-public-contracts-2026-10-13.md) (research only: the design doc is archived below as implemented). It is relevance gating through public APIs, not an access-control boundary. Optional ideas in retired handoffs were not scheduled requirements.
