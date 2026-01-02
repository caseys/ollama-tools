# Plan: Remove ksp-mcp Assumptions from `ollama-tools`

## Goals
- Let the agent connect to any MCP server without Kerbal-specific paths, terminology, or heuristics.
- Keep the overlay prompts + pipeline unchanged structurally, but ensure all KSP details move behind configuration.
- Preserve existing behaviour for ksp-mcp users via config/env defaults supplied by that repo, not this adapter.

## Constraints / Non-goals
- No behaviour changes to consensus/pipeline logic beyond removing hard-coded examples and filters.
- Any KSP-specific patches (CPU defaults, script output filtering, etc.) should relocate to ksp-mcp or become opt-in via config.

---

## Workstream 1 – Configuration & Bootstrapping
1. **Config defaults** (`src/config/parser.ts`, `README.md`, `package.json`):
   - Replace the baked-in default `../ksp-mcp/dist/index.js` path with an and replace with CLI/env input. do we skip this for http?
   - Update docs to explain that each MCP service must be provided via `MCP_BIN`/`MCP_HTTP_URL`, and mention ksp-mcp only as an example.
   - Clarify CLI usage text so `npm start` without configuration tells the operator what to set.
2. **Log prefixing** (`src/mcp/client.ts`):
   - Swap the `[ksp-mcp]` stderr tag with a neutral `[mcp]` (or derive from binary name) so logs stay accurate when another MCP is used.

## Workstream 2 – Resource handling and prompts
3. **Generalise status fetching** (`src/mcp/resources.ts`, overlays calling `fetchStatusInfo`):
   - Introduce configuration for optional `STATUS_RESOURCE_URI`, update .env_example and .env
   - default to use any 'status/info/state/help' resource or tool if available.
   - log once if status is unavailable.
   - Allow overlays to handle missing status context gracefully (keep `"No status available."` but remove KSP references).
4. **Prompt cleanup** (`src/overlay/select-tool.ts`, `src/overlay/reflect.ts`, `README.md` examples):
   - Remove hard-coded example tool names like `hohmann_transfer`, `launch_and_circularize`, and KSP scenarios (“go to Mun”).
   - Replace with neutral examples or dynamically derive from the current tool list/history.
   - Can we dynamically derive parts of MCP tool catalog?  that may not be allowed?
   - Docs can use ksp-mcp examples, but please ensure prompt text describe behaviour generically (“launch mission” → “swing hammer”).

## Workstream 3 – Tool argument/result normalization
5. **Argument sanitation hooks** (`src/utils/tools.ts`, `src/utils/strings.ts`):
   - Regarding the implicit `cpuId`/`cpuLabel` and script keyword filters from the general adapter:
    - consider what type of general filtering will help LLM deal with tool result data.
    - remove ksp-mcp specific filters IF the change is non-breaking or can be replaced with more general approach.
    - add notes to plan-ksp-mcp.md about filtering out things like this.
6. **Structured result filtering** (`src/utils/strings.ts#removeScriptNoise`):
    - consider what type of general filtering will help LLM deal with tool result noise/data.
    - remove ksp-mcp specific filters IF the change is non-breaking or can be replaced with more general approach.
    - add notes to plan-ksp-mcp.md about filtering out things like this.

## Workstream 4 – Documentation & Samples
7. **Type definitions** (`src/types.ts`):
   - Remove KSP-specific `StatusInfo` fields, somehow we have to allow anything here.
   - Ensure any remaining references (e.g., `ksp::` URIs) become var/const that are set when we know what MCP service we're using.
