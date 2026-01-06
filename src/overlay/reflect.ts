/**
 * Reflect step: evaluates tool results and decides next action.
 *
 * Uses a single LLM call that outputs one of:
 * - DONE: all goals satisfied
 * - ASK: <question>: needs user clarification
 * - <remaining work>: what still needs to be done
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { TurnInput, TurnWorkingState, ReflectionDecision, ToolEvent } from "../core/turn-types.js";
import { callLLM } from "../core/services.js";
import { fetchStatusInfo } from "../mcp/resources.js";
import { formatToolsByTier } from "../utils/tools.js";

// === Dependencies ===

export interface ReflectDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  toLLMLog: Logger;
}

// === Helpers ===

function formatCompletedWork(toolResults: ToolEvent[]): string {
  if (toolResults.length === 0) return "(none yet)";

  return toolResults
    .map((e, i) => {
      const statusIcon = e.success ? "\u2713" : "\u2717";
      return `${i + 1}. ${e.toolName} ${statusIcon}`;
    })
    .join("\n");
}

function generateDefaultSummary(state: TurnWorkingState): string {
  const successful = state.groupToolResults.filter((e) => e.success);
  if (successful.length === 0) {
    return "I was not able to complete your request. Please try rephrasing.";
  }
  const actions = successful.map((e) => e.toolName).join(", ");
  return `Completed: ${actions}. What would you like to do next?`;
}

function buildContext(
  state: TurnWorkingState,
  statusInfo: string,
  deps: ReflectDeps
): string {
  let toolSelectionContext = "";
  if (state.lastToolSelectionResult) {
    const { selectedTool, consensusCount, queriesRun } = state.lastToolSelectionResult;
    if (!selectedTool && queriesRun > 0) {
      toolSelectionContext = `

TOOL SELECTION: None selected (${consensusCount}/${queriesRun} consensus on "no tool needed")
This indicates the model is confident no more actions are required.`;
    }
  }

  // Count failures and build warning if needed
  const failures = state.groupToolResults.filter((e) => !e.success);
  const failureCount = failures.length;
  let failureWarning = "";
  if (failureCount > 0) {
    const failedTools = failures.map((e) => e.toolName).join(", ");
    failureWarning = `

⚠️ FAILURES: ${failureCount} tool(s) failed this session: ${failedTools}
If the same tool keeps failing, ASK the user for help rather than retrying.`;
  }

  return `${deps.agentPrompts.roleForAssistant}

ORIGINAL REQUEST:
${state.originalQuery}

MISSION PROGRESS:
${formatCompletedWork(state.groupToolResults)}${toolSelectionContext}${failureWarning}

AVAILABLE TOOLS:
${formatToolsByTier(deps.toolInventory)}

STATUS:
${statusInfo || "No status available."}

ITERATION: ${state.iteration}/${state.maxIterations}`;
}

// === Main Reflect Call ===

/**
 * Determine remaining work, or if done/needs clarification.
 * Returns one of:
 * - "DONE" - all goals satisfied
 * - "ASK: <question>" - needs user clarification
 * - "<remaining work>" - what still needs to be done
 */
async function getRemainingQuery(
  context: string,
  state: TurnWorkingState,
  deps: ReflectDeps
): Promise<string> {
  // Include last successful tool result for advice extraction
  const lastSuccess = state.groupToolResults.filter(e => e.success).at(-1);
  const toolAdviceSection = lastSuccess
    ? `\nLAST TOOL OUTPUT (${lastSuccess.toolName}):\n${lastSuccess.result.slice(0, 500)}`
    : "";

  // Check for failures that might need user help
  const failures = state.groupToolResults.filter((e) => !e.success);
  const failureSection = failures.length > 0
    ? `\n\n⚠️ FAILURES: ${failures.map(f => f.toolName).join(", ")} - if stuck, ask the user for help`
    : "";

  const user = `TASK: Determine what work remains to complete the original request.

ORIGINAL REQUEST: "${state.originalQuery}"
${toolAdviceSection}${failureSection}

RULES:
- Verify goals against STATUS and MISSION PROGRESS
- A tool completing ✓ does NOT mean the goal is achieved
- Check MISSION PROGRESS for suggested next steps from tool outputs
- If multiple tools keep failing, ask the user for help

OUTPUT (one of):
- DONE - if all goals in original request are satisfied per STATUS
- ASK: <question> - if you need user clarification
- <remaining work> - what still needs to be done`;

  // Log the prompts for debugging
  deps.toLLMLog("[toLLM] ─── Reflect RemainingQuery ───");
  deps.toLLMLog("[system]");
  deps.toLLMLog(context);
  deps.toLLMLog("[user]");
  deps.toLLMLog(user);

  const result = await callLLM(
    deps.ollamaClient,
    [
      { role: "system", content: context },
      { role: "user", content: user },
    ],
    [],
    { spinnerMessage: "Reflecting", silent: true }
  );

  return result.content.trim() || state.originalQuery;
}

async function getSummary(
  context: string,
  state: TurnWorkingState,
  deps: ReflectDeps
): Promise<string> {
  const user = `TASK: Summarize what THIS MISSION accomplished.

RULES:
- ONLY describe tools listed in MISSION PROGRESS
- If MISSION PROGRESS shows "(none yet)", say "No actions were taken"
- Do NOT infer actions from STATUS - that's historical context

OUTPUT: 1-2 sentences about THIS mission only.`;

  // Log the prompts for debugging
  deps.toLLMLog("[toLLM] ─── Reflect Summary ───");
  deps.toLLMLog("[system]");
  deps.toLLMLog(context);
  deps.toLLMLog("[user]");
  deps.toLLMLog(user);

  const result = await callLLM(
    deps.ollamaClient,
    [
      { role: "system", content: context },
      { role: "user", content: user },
    ],
    [],
    { spinnerMessage: "Summarizing", silent: true }
  );

  return result.content.trim() || generateDefaultSummary(state);
}

// === Main Function ===

/**
 * Parse the reflect output to determine action.
 */
function parseReflectOutput(output: string): { action: "done" | "ask" | "continue"; value: string } {
  const trimmed = output.trim();
  const upper = trimmed.toUpperCase();

  // Check for DONE
  if (upper === "DONE" || upper.startsWith("DONE.") || upper.startsWith("DONE:")) {
    return { action: "done", value: "" };
  }

  // Check for ASK: <question>
  if (upper.startsWith("ASK:") || upper.startsWith("ASK ")) {
    const question = trimmed.slice(4).trim();
    return { action: "ask", value: question || "How would you like to proceed?" };
  }

  // Otherwise it's remaining work
  return { action: "continue", value: trimmed };
}

export async function reflectAndSummarize(
  state: TurnWorkingState,
  input: TurnInput,
  deps: ReflectDeps
): Promise<ReflectionDecision> {
  const failureCount = state.groupToolResults.filter((e) => !e.success).length;
  deps.agentLog(`[reflect] Iteration ${state.iteration}, ${state.groupToolResults.length} tool(s) completed, ${failureCount} failed`);

  // Use cached status or fetch fresh (typically fresh after tool execution)
  let statusInfo: string;
  if (state.cachedStatusInfo !== undefined) {
    deps.agentLog("[reflect] Using cached status");
    statusInfo = state.cachedStatusInfo;
  } else {
    deps.spinner.start("Reading status");
    const result = await fetchStatusInfo(
      deps.client,
      { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
      "Reflecting "
    );
    statusInfo = result.statusInfo;
    state.cachedStatusInfo = statusInfo;
  }

  // Build shared context (system block)
  const context = buildContext(state, statusInfo, deps);

  // Single call: get remaining work (or DONE/ASK)
  const output = await getRemainingQuery(context, state, deps);
  const parsed = parseReflectOutput(output);
  deps.agentLog(`[reflect] Output: "${output}" → ${parsed.action}`);

  switch (parsed.action) {
    case "done": {
      const summary = await getSummary(context, state, deps);
      return { action: "done", summary };
    }
    case "ask": {
      return { action: "ask", question: parsed.value };
    }
    case "continue": {
      // Validate: if remaining is empty/none, task is actually done
      const lower = parsed.value.toLowerCase();
      if (!parsed.value || lower === "none" || lower === "nothing" || lower === "n/a") {
        deps.agentLog(`[reflect] Empty remaining query, overriding to DONE`);
        const summary = await getSummary(context, state, deps);
        return { action: "done", summary };
      }
      return { action: "continue", remainingQuery: parsed.value };
    }
  }
}
