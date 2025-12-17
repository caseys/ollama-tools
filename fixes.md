# Remediation Plan

## Goals
- Preserve the sequential execution behavior that auto-runs planned tool sequences.
- Relax `sanitizeToolText` so MCP output keeps meaningful Unicode characters.
- Prevent cross-turn conversation bloat now that summaries already capture prior turns.
- Remove dead plan-enforcement logic from the open-ended agent loop to avoid confusion.
- Ensure the fallback tool selection never exposes the entire catalog beyond the configured limit.
- Keep an audit copy of the original sanitizer for reference in `~/src/ksp-mcp/sanitize-more.md`.

## Tasks
1. **Document and Archive**
   - Copy the current `sanitizeToolText` implementation into `~/src/ksp-mcp/sanitize-more.md` before making changes.
   - Note the behavior difference so future MCP work can refer back if needed.
2. **Sanitizer Update**
   - Rewrite `sanitizeToolText` to strip only control characters (C0/DEL) and normalize whitespace while leaving extended Unicode intact.
   - Maintain newline collapsing/trim logic so logs stay compact.
3. **Conversation Lifecycle**
   - After each open-ended request finishes, drop all transient conversation entries except the original system/primer message so the next request starts fresh.
   - Rely on the existing history summary to give the model continuity.
4. **Planning Code Cleanup**
   - Remove the unused plan-guidance prompts/responses inside `runAgentLoop` along with their helper functions, since sequential mode already owns the planning path.
   - This eliminates misleading branches the model never executes.
5. **Tool Selection Fallback**
   - When no scored tools exist (or inventory is empty), cap the fallback list to `MAX_TOOLS_PER_CALL` entries instead of dumping the entire catalog.

## Validation
- Spot-check sanitizer output by feeding a multi-language string into the helper to ensure accented characters remain.
- Exercise the REPL manually (or via unit simulation) to confirm a second prompt no longer duplicates prior tool transcripts.
- Run `node agent.js --help` (or start the agent) to ensure no syntax errors after removing plan helpers.
