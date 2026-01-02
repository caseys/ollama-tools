# Plan: Move KSP-specific Behaviour into `ksp-mcp`

## Goals
- Provide all Kerbal-specific defaults from the MCP server itself so generic clients (like `ollama-tools`) stay service-agnostic.
- Ship an operator-friendly way to configure CPU IDs, vessel targets, and other frequently tweaked settings without editing env vars.
- Emit rich metadata so adapters can auto-surface prompts, tool tiers, and argument sanitation rules.

## Constraints / Notes
- Changes should remain backward compatible with the current schema consumed by `ollama-tools` (tool list, resources, prompts).
- Prefer MCP primitives (resources, prompts, tools) over ad-hoc env vars so multiple clients can share the same behaviour.

---

## Workstream 1 – Server-supplied defaults & metadata
1. **Tool tier metadata**:
   - Continue sending `_meta.tier`, but document the meaning (1=common, 3=specialized) and ensure every tool defines it.
   - Add `_meta.argumentTransforms` describing fields that require normalization (e.g., `{ field: "cpuId", type: "kosCpuId" }`) so adapters know when to coerce.
2. **Status/introspective resources**:
   - Provide a neutral `status://summary` (or similar) resource that contains formatted + structured fields, replacing the hard-coded `ksp://status`.
   - Include `history://reminders` (if needed) so clients can surface reminders without Kerbal-specific logic.
3. **Prompt inventory**:
   - Supply onboarding/prompts that mention agent roles, reflection instructions, etc., so adapters can fetch them instead of baking examples.

## Workstream 2 – Advanced configuration tool
4. **Interactive config tool**:
   - Add a `configure_agent` (or `ksp_configure`) MCP tool that lets the model list and set defaults such as CPU ID/label, preferred autopilot, and safe-mode parameters.
   - Ensure the tool validates values with in-sim data (enumerate CPUs, autopilots) and persists selections (e.g., JSON file).
   - Surface the config’s current state via `resource://agent-config` for read-only usage.
5. **Fallback defaults**:
   - When configuration hasn’t been run, provide sensible defaults (CPU 0, active vessel autopilot, etc.) so generic clients don’t need heuristics.

## Workstream 3 – Output & error shaping
6. **Server-side sanitization**:
   - Move the script-noise filtering into ksp-mcp responses (either by trimming kOS command echos before sending or by providing filtered `structuredContent`).
   - Attach human-readable summaries in `structuredContent.action/status` for each tool, mirroring what the adapter expects.
7. **Error taxonomy**:
   - Normalize error payloads (timeouts, invalid args) so that every failure returns `{ structuredContent: { status: "error", reason: "..." } }`.

## Workstream 4 – Documentation & validation
8. **Docs**:
   - Document the new metadata fields and configuration workflow so any MCP client can take advantage of them.
9. **End-to-end test**:
   - Create a small integration test (or script) that runs ksp-mcp with the new defaults and ensures the exported tool list + resources include the metadata expected by `ollama-tools`.
