/**
 * Reflect step: evaluates tool results and decides next action.
 *
 * Uses two sequential LLM calls with simple string responses:
 * 1. Decision call: CONTINUE, DONE, or ASK
 * 2. Follow-up call: remainingQuery, summary, or question
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
import { runWithConsensus } from "../core/consensus.js";
import type { SamplingParams } from "../core/retry.js";

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
      // Truncate error results to avoid huge MCP error dumps (but keep enough for context)
      let result = e.result;
      if (!e.success && result.length > 500) {
        result = result.slice(0, 500) + "...";
      }
      return `${i + 1}. ${e.toolName} ${statusIcon}:\n${result}`;
    })
    .join("\n\n");
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

COMPLETED WORK:
${formatCompletedWork(state.groupToolResults)}${toolSelectionContext}${failureWarning}

AVAILABLE TOOLS:
${formatToolsByTier(deps.toolInventory)}

STATUS:
${statusInfo || "No status available."}

ITERATION: ${state.iteration}/${state.maxIterations}`;
}

// === Decision Call ===

type Decision = "continue" | "done" | "ask";

function parseDecision(raw: string): Decision {
  const lower = raw.toLowerCase();

  // Explicit done indicators - must say done/complete/satisfied
  if (lower.includes("done") || lower.includes("satisfied") || lower === "complete") {
    return "done";
  }

  // Ask indicators
  if (lower.includes("ask") || lower.includes("clarif")) {
    return "ask";
  }

  // Everything else (including "continue", ambiguous responses) → continue
  // This is safer for multi-step tasks
  return "continue";
}

async function getDecision(
  context: string,
  deps: ReflectDeps
): Promise<Decision> {
  const prompt = `${context}

TASK: Is the ORIGINAL REQUEST **fully** satisfied?

CRITICAL: Evaluate the ENTIRE original request, not just individual steps.
- "create and deploy" requires BOTH actions, not just one
- "search and replace" requires BOTH actions, not just one
- If TOOL SELECTION shows "no tool needed" with high consensus, the task is likely complete.
- If multiple tools have FAILED (see ⚠️ FAILURES above), choose ASK to get user help.

Reply with exactly ONE word:
- CONTINUE - More work remains (request is NOT fully complete)
- DONE - The ENTIRE request is fully satisfied
- ASK - Cannot proceed without user clarification (USE THIS if tools keep failing)`;

  // Log the reflect prompt for debugging
  deps.toLLMLog("[toLLM] ─── Reflect Decision Prompt ───");
  deps.toLLMLog(prompt);

  let queryIndex = 0;
  const consensusResult = await runWithConsensus<Decision>(
    async (params: SamplingParams) => {
      queryIndex++;
      deps.spinner.update(`Reflecting (${queryIndex})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      try {
        const result = await deps.ollamaClient.callWithSignal(
          [{ role: "system", content: prompt }],
          [],
          controller.signal,
          {
            options: { temperature: params.temperature, stop: ["\n"] },
            silent: true,
          }
        );
        clearTimeout(timeoutId);

        const raw = result.message?.content?.trim() ?? "";
        deps.agentLog(`[reflect] Query (temp=${params.temperature}): "${raw}"`);

        return parseDecision(raw);
      } catch (error) {
        clearTimeout(timeoutId);
        deps.agentWarn(`[reflect] Query failed (temp=${params.temperature}): ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    (a, b) => a === b,
    { maxQueries: 3, minMatches: 2, matchMode: "exact" }
  );

  // Log consensus results
  for (const [index, result] of consensusResult.allResults.entries()) {
    deps.agentLog(`[reflect] Query ${index + 1}: ${result}`);
  }
  deps.agentLog(`[reflect] Consensus: ${consensusResult.matchCount}/${consensusResult.queriesRun} → ${consensusResult.result ?? "none"}`);

  return consensusResult.result ?? "continue";
}

// === Follow-up Calls ===

async function getRemainingQuery(
  context: string,
  state: TurnWorkingState,
  deps: ReflectDeps
): Promise<string> {
  // Check if remainingQuery has clarification context that needs stripping
  const hasClarification = state.remainingQuery.includes("[User clarified");
  const clarificationNote = hasClarification
    ? `\nNote: Strip any "[User clarified...]" lines - that context was for a completed tool call.`
    : "";

  const prompt = `${context}

TASK: What specific action remains to complete the original request?

Original: "${state.originalQuery}"
Completed work is listed in COMPLETED WORK above.${clarificationNote}

IMPORTANT: Reply with the SPECIFIC remaining action, not a summary.
- If everything is done, reply with exactly: NONE
- Otherwise reply with the remaining task (e.g., "land on the Mun")

DO NOT reply with meta-commentary. Only the task or NONE.`;

  const result = await callLLM(
    deps.ollamaClient,
    [{ role: "system", content: prompt }],
    [],
    { spinnerMessage: "Planning next step", silent: true }
  );

  return result.content.trim() || state.originalQuery;
}

async function getSummary(
  context: string,
  state: TurnWorkingState,
  deps: ReflectDeps
): Promise<string> {
  const prompt = `${context}

TASK: Summarize what was accomplished.

Reply with 1-2 sentences for the user describing what was done.`;

  const result = await callLLM(
    deps.ollamaClient,
    [{ role: "system", content: prompt }],
    [],
    { spinnerMessage: "Summarizing", silent: true }
  );

  return result.content.trim() || generateDefaultSummary(state);
}

async function getQuestion(
  context: string,
  state: TurnWorkingState,
  deps: ReflectDeps
): Promise<string> {
  // Get most recent failure for focused questioning
  const failures = state.groupToolResults.filter((e) => !e.success);
  const lastFailure = failures.at(-1);

  let taskPrompt: string;
  if (lastFailure) {
    // Focus on the specific error
    taskPrompt = `TASK: The tool "${lastFailure.toolName}" failed with this error:
${lastFailure.result}

Ask the user ONE specific question about how to handle this error.
- Focus on the error message and what options the user has
- Do NOT ask about mission objectives or clarifications unrelated to the error
- Be concise and actionable`;
  } else {
    taskPrompt = `TASK: What question should we ask the user?

Reply with the question only.`;
  }

  const prompt = `${context}

${taskPrompt}`;

  const result = await callLLM(
    deps.ollamaClient,
    [{ role: "system", content: prompt }],
    [],
    { spinnerMessage: "Formulating question", silent: true }
  );

  return result.content.trim() || "How would you like to proceed?";
}

// === Main Function ===

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
    const result = await fetchStatusInfo(
      deps.client,
      { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
      "Reflecting "
    );
    statusInfo = result.statusInfo;
    state.cachedStatusInfo = statusInfo;
  }

  // Build shared context
  const context = buildContext(state, statusInfo, deps);

  // Call 1: Get decision
  const decision = await getDecision(context, deps);
  deps.agentLog(`[reflect] Decision: ${decision}`);

  // Call 2: Get follow-up based on decision
  if (decision === "continue") {
    const remainingQuery = await getRemainingQuery(context, state, deps);
    deps.agentLog(`[reflect] Remaining: ${remainingQuery}`);

    // Validate: if remaining is empty/none, task is actually done
    const lower = remainingQuery.toLowerCase().trim();
    if (!remainingQuery.trim() || lower === "none" || lower === "nothing" || lower === "n/a") {
      deps.agentLog(`[reflect] Empty remaining query, overriding to DONE`);
      const summary = await getSummary(context, state, deps);
      return { action: "done", summary };
    }

    return { action: "continue", remainingQuery };
  }

  if (decision === "ask") {
    const question = await getQuestion(context, state, deps);
    return { action: "ask", question };
  }

  // decision === "done"
  const summary = await getSummary(context, state, deps);
  return { action: "done", summary };
}
