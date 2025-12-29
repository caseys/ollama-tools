# State Machine Refactor Implementation Plan

## Overview
Refactor the ollama-tools pipeline from sequential step execution to a state machine with single-tool selection per iteration.

**Target Flow:** WAIT_USER → SELECT_TOOL → EXECUTE → REFLECT/SUMMARIZE → (loop or done)

## Key Concept: Iteration Groups

When a user query requires multiple tools, those iterations form an **iteration group**:
- Iteration number starts at 1 and increments within the group
- Planning and reflect steps prioritize tool results from the current group
- Reflect step creates a **remaining query** (original minus completed work)
- Original user query is preserved separately from the working query
- When original query is satisfied, the group ends and iteration resets to 0
- History entries track which group they belong to

## New Files to Create

### 1. `src/core/turn-types.ts` (~100 lines)
Type definitions for the new architecture:
```typescript
interface TurnInput { userInput, previousResponse, inputSource }

interface TurnWorkingState {
  turnId,
  groupId,                    // Unique ID for this iteration group
  iteration,                  // Resets to 1 at start of each group
  maxIterations,
  originalQuery,              // Preserved original user query
  remainingQuery,             // Working query (original minus completed work)
  currentTool,
  groupToolResults[],         // Tool results from THIS group only
  reminders[]
}

interface TurnOutput { response, stateSummary, branch }

interface ToolEvent { id, toolName, args, result, success, timestamp, groupId }

interface Reminder { toolName, reason, sourceToolEventId }

type ReflectionDecision =
  | { action: "continue", remainingQuery }  // More tools needed, updated query
  | { action: "done", summary }             // Group complete, query satisfied
  | { action: "ask", question }             // Need user clarification
```

### 2. `src/core/services.ts` (~120 lines)
Unified wrappers for external services (Ollama LLM, MCP tools):
- `callLLM()`: wraps ollamaClient with retry/backoff, returns { content, toolCalls, attempts }
- `callMcpTool()`: wraps MCP callTool, returns ToolEvent with normalized result

### 3. `src/core/machine.ts` (~100-130 lines)
Thin state machine orchestrator:
- Enum: `MachineState { WAIT_USER, SELECT_TOOL, EXECUTE, REFLECT_SUMMARIZE, DONE }`
- Single `runTurn(input, deps)` function with while loop over states
- MAX_ITERATIONS = 6 constant
- Calls overlay modules for each state's logic

### 4. `src/overlay/select_tool.ts` (~280 lines)
Fork from plan_tools.ts with key changes:
- Returns `string | null` (single tool) instead of `string[]`
- Prompt includes `groupToolResults` (current iteration group only) for context
- Receives `remainingQuery` (not original) for tool selection
- Knows its iteration number within the group
- Keeps consensus with 7 temps + early exit
- Removes ordering query logic (not needed)

### 5. `src/overlay/reflect.ts` (~180 lines)
Merges execute.ts reflection + summary.ts logic:
- Compares `originalQuery` vs `groupToolResults` to evaluate progress
- If more tools needed: creates `remainingQuery` (original minus completed work), returns `{ action: "continue", remainingQuery }`
- If original query satisfied: ends iteration group, returns `{ action: "done", summary }` with user-facing response
- If clarification needed: returns `{ action: "ask", question }`
- May extract reminders from tool results for future iterations

## Files to Modify

### `src/overlay/execute.ts` (~150 lines, down from 413)
Simplify to single-tool execution:
- Remove the for loop (only one tool per call)
- Remove embedded reflection logic (moved to reflect.ts)
- Use `callMcpTool()` from services.ts
- Return `ToolEvent` instead of `ToolExecutionResult`

### `src/index.ts` (~200 lines)
Switch to state machine:
- Replace `runPipeline()` with `runTurn()` from machine.ts
- Create `TurnInput` instead of `PipelineContext`
- Create `MachineDeps` with all dependencies
- Update history tracking to use new types

## Files to Delete
- `src/core/pipeline.ts` - replaced by machine.ts
- `src/overlay/summary.ts` - merged into reflect.ts
- `src/overlay/plan_tools.ts` - replaced by select_tool.ts (after migration)

Already deleted (per git status):
- `src/overlay/intro.ts`, `src/overlay/preflight.ts`, `src/overlay/stt_correct.ts`

## Implementation Order

### Phase 1: Foundation (no breaking changes)
1. Create `src/core/turn-types.ts`
2. Create `src/core/services.ts`

### Phase 2: Overlay Modules
3. Create `src/overlay/reflect.ts`
4. Create `src/overlay/select_tool.ts` (fork from plan_tools.ts)
5. Modify `src/overlay/execute.ts` (simplify to single tool)

### Phase 3: Integration
6. Create `src/core/machine.ts`
7. Modify `src/index.ts` to use runTurn

### Phase 4: Cleanup
8. Delete `src/core/pipeline.ts`
9. Delete `src/overlay/summary.ts`
10. Delete `src/overlay/plan_tools.ts`

## Key Design Decisions

1. **Single tool per iteration**: SELECT_TOOL picks one tool → EXECUTE runs it → REFLECT decides if more needed
2. **Iteration groups**: Iterations solving the same user query form a group; iteration counter resets when group ends
3. **Query rewriting**: Reflect creates `remainingQuery` (original minus completed work); `originalQuery` preserved
4. **Group-aware context**: Planning and reflect prioritize `groupToolResults` (current group only)
5. **Consensus preserved**: Keep 7-temp consensus with early exit for tool selection reliability
6. **Reminders**: Structured records in TurnWorkingState for carrying forward tool prerequisites
7. **MAX_ITERATIONS = 6**: Single counter per group, checked in SELECT_TOOL state

## State Transitions

| From | To | Condition |
|------|----|-----------|
| SELECT_TOOL | EXECUTE | Tool selected |
| SELECT_TOOL | REFLECT_SUMMARIZE | No tool (done or clarify) |
| EXECUTE | REFLECT_SUMMARIZE | Tool complete |
| REFLECT_SUMMARIZE | SELECT_TOOL | action="continue" |
| REFLECT_SUMMARIZE | DONE | action="done" or "ask" |

## Preserved Logic
- Retry utilities (`src/core/retry.ts`) - unchanged
- Consensus utilities (`src/core/consensus.ts`) - unchanged
- Ollama client (`src/core/ollama.ts`) - unchanged, wrapped by services.ts
- Tool utilities (`src/utils/tools.ts`) - unchanged
- Agent prompts (`src/overlay/agent.ts`) - unchanged, startup only
