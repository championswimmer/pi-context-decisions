# Archived research and validation evidence

These dated documents preserve provider/API evidence, catalog provenance, and live-validation results. They are **historical records, not pending implementation plans**. Their contents are unchanged from the former `.agents/plans/` location; references to that layout or retired handoffs describe the repository at the time of research. Retired handoffs remain available in Git history.

- [Direct provider research](direct-provider-research.md): TypeSafe, OpenAI, and OpenRouter protocol contracts and sources.
- [Pi integration research](pi-integration-research.md): Pi 1.1.0 host APIs, especially the tool/MCP visibility limits referenced by the pending plan.
- [OpenRouter weekly popularity](openrouter-weekly-popularity.md): the original top-ten snapshot and token-ranking provenance.
- [Live provider validation, 2026-10-12](live-provider-validation-2026-10-12.md): account-specific routing checks explaining the eight retained OpenRouter models.
- [Direct OpenAI with Pi credentials, 2026-10-12](live-openai-pi-credentials-2026-10-12.md): completed source-aware credential integration and bounded Luna smoke validation.

Current behavior is documented in [README.md](../../README.md) and [AGENTS.md](../../AGENTS.md), and verified by `src/` and `test/`. It supersedes historical dynamic-discovery, fail-open-default, public `noul`, old command-name, and env-only smoke proposals. Runtime discovery is absent; the catalog is static, filtering defaults to fail closed, the public primitive is `bool`, the command is `/decisions`, and smoke credentials are Pi-first/env-second. Historical unverified checks or pending test reruns are not current repository status.

The only pending implementation handoff is [MCP/tool visibility](../plans/mcp-visibility.md). It is unscheduled and is not an implemented permission boundary. Optional ideas in retired handoffs were not scheduled requirements.
