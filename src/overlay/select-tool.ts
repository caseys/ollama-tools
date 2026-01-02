/**
 * Select Tool step: picks the NEXT tool to execute.
 *
 * Key differences from the old plan_tools.ts:
 * - Returns `string | undefined` (single tool) instead of `string[]`
 * - Prompt includes groupToolResults (current iteration group only) for context
 * - Receives remainingQuery (not original) for tool selection
 * - Knows its iteration number within the group
 * - Keeps consensus with 7 temps + early exit
 * - Removes ordering query logic (not needed for single tool)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, OllamaMessage, AgentPrompts } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { TurnInput, TurnWorkingState, ToolEvent } from "../core/turn-types.js";
import { extractAssistantText } from "../utils/strings.js";
import { formatToolsByTier } from "../utils/tools.js";
import { summarizeHistory } from "../utils/history.js";
import { runWithConsensus } from "../core/consensus.js";
import { fetchStatusInfo } from "../mcp/resources.js";
import type { SamplingParams } from "../core/retry.js";

// === Dependencies ===

export interface SelectToolDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  history: Array<{ prompt: string; toolEvents?: Array<{ name: string; success: boolean }>; finalSummary?: string }>;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  toLLMLog: Logger;
}

// === Parser ===

interface ParsedSelection {
  tool: string | undefined;
  isDone: boolean;
  question: string | undefined;  // Non-matching text treated as question
}

function parseSingleToolResponse(
  text: string | undefined,
  toolInventory: InventoryEntry[]
): ParsedSelection {
  if (!text || !text.trim()) {
    return { tool: undefined, isDone: false, question: undefined };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Check for explicit done/null/none responses
  if (lower === "done" || lower === "null" || lower === "none" || lower === "false" || lower === "complete" || lower === "completed") {
    return { tool: undefined, isDone: true, question: undefined };
  }

  // Build set of valid tool names (lowercase for comparison)
  const toolNames = new Map(
    toolInventory.map((e) => [e.openAi.function.name.toLowerCase(), e.openAi.function.name])
  );

  // Exact match: find the tool name in the response
  for (const [lowerName, canonicalName] of toolNames) {
    if (lower.includes(lowerName)) {
      return { tool: canonicalName, isDone: false, question: undefined };
    }
  }

  // No tool match - treat as a question to user
  return { tool: undefined, isDone: false, question: trimmed };
}

// === Consensus Matching ===

function selectionsMatch(a: ParsedSelection, b: ParsedSelection): boolean {
  // Both done
  if (a.isDone && b.isDone) return true;
  // Both same tool
  if (a.tool && b.tool && a.tool === b.tool) return true;
  // Both questions (we don't compare question text, just that both are questions)
  if (a.question && b.question) return true;
  return false;
}

// === Query Building ===

function formatPreviousResults(toolResults: ToolEvent[]): string {
  if (toolResults.length === 0) return "";

  const entries = toolResults.map((e, i) => {
    const statusIcon = e.success ? "\u2713" : "\u2717";
    // Truncate error results to avoid huge MCP error dumps (but keep enough for context)
    let result = e.result;
    if (!e.success && result.length > 500) {
      result = result.slice(0, 500) + "...";
    }
    return `${i + 1}. ${e.toolName} ${statusIcon}:\n${result}`;
  });

  return `\nPREVIOUS RESULTS (this session):\n${entries.join("\n\n")}`;
}

function buildSelectToolPrompt(
  remainingQuery: string,
  previousResults: ToolEvent[],
  iteration: number,
  maxIterations: number,
  toolInventory: InventoryEntry[],
  agentPrompts: AgentPrompts,
  historySummary: string,
  statusInfo: string
): OllamaMessage[] {
  const previousContext = formatPreviousResults(previousResults);

  // Show last failure for context (but don't tell LLM to avoid - might need retry with different args)
  const lastFailure = previousResults.filter(e => !e.success).at(-1);
  const lastFailureNote = lastFailure
    ? `\n⚠️ LAST FAILURE: ${lastFailure.toolName} - may need different arguments if retrying`
    : '';

  const system = `${agentPrompts.roleForAssistant}

TOOLS:
${formatToolsByTier(toolInventory)}

STATUS:
${statusInfo || "No status available."}

HISTORY (previous sessions):
${historySummary || "This is the first request."}
${previousContext}
${lastFailureNote}

ITERATION: ${iteration}/${maxIterations}

TASK: Select the NEXT tool to work toward completing the user request.

RULES:
1. Select ONE tool that advances toward the goal
2. Consider what has already been done in PREVIOUS RESULTS
3. If the request is already satisfied or no tool applies, say "done"
4. Do not repeat tools that already succeeded for the same purpose
5. As last resort, get clarification from the user by asking a question
6. If you are 100% sure we are done, reply with "done".

OUTPUT: Reply with ONLY a tool name.`;

  return [
    { role: "system", content: system },
    { role: "user", content: remainingQuery },
  ];
}

// === Query Execution ===

async function runSelectionQuery(
  messages: OllamaMessage[],
  toolInventory: InventoryEntry[],
  params: SamplingParams,
  deps: SelectToolDeps
): Promise<ParsedSelection> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 30_000);

  try {
    const response = await deps.ollamaClient.callWithSignal(
      messages,
      [],
      controller.signal,
      {
        options: {
          temperature: params.temperature,
          top_p: params.top_p,
          top_k: params.top_k,
          ...(params.stop && { stop: params.stop }),
        },
        silent: true,
        spinnerMessage: "Selecting tool",
      }
    );
    clearTimeout(timeoutId);

    const text = extractAssistantText(response.message).trim();
    if (!text) {
      deps.agentLog(`[select] Query (temp=${params.temperature}) returned empty`);
      return { tool: undefined, isDone: false, question: undefined };
    }

    deps.agentLog(`[select] Query (temp=${params.temperature}): "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
    return parseSingleToolResponse(text, toolInventory);
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[select] Query failed (temp=${params.temperature}): ${error instanceof Error ? error.message : String(error)}`);
    return { tool: undefined, isDone: false, question: undefined };
  }
}

// === Result Type ===

export interface SelectToolResult {
  tool: string | undefined;
  isDone: boolean;
  question: string | undefined;  // LLM returned a question instead of tool
  consensusCount: number;
  queriesRun: number;
}

// === Main Function ===

export async function selectTool(
  state: TurnWorkingState,
  input: TurnInput,
  deps: SelectToolDeps
): Promise<SelectToolResult> {
  deps.agentLog(`[select] Iteration ${state.iteration}/${state.maxIterations}`);

  // Guard against empty or "none" remaining queries
  const trimmedQuery = state.remainingQuery.trim();
  const lowerQuery = trimmedQuery.toLowerCase();
  if (!trimmedQuery || lowerQuery === "none" || lowerQuery === "nothing" || lowerQuery === "n/a") {
    deps.agentLog("[select] Empty/none remaining query, returning done");
    return { tool: undefined, isDone: true, question: undefined, consensusCount: 0, queriesRun: 0 };
  }

  // Use cached status or fetch fresh
  let statusInfo: string;
  if (state.cachedStatusInfo !== undefined) {
    deps.agentLog("[select] Using cached status");
    statusInfo = state.cachedStatusInfo;
  } else {
    const result = await fetchStatusInfo(
      deps.client,
      { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
      "Selecting "
    );
    statusInfo = result.statusInfo;
    state.cachedStatusInfo = statusInfo;
  }

  // Summarize history from previous sessions
  const historySummary = summarizeHistory(deps.history, 5);

  // Build the selection prompt
  const messages = buildSelectToolPrompt(
    state.remainingQuery,
    state.groupToolResults,
    state.iteration,
    state.maxIterations,
    deps.toolInventory,
    deps.agentPrompts,
    historySummary,
    statusInfo
  );

  deps.toLLMLog("[toLLM] ─── Select Tool Prompt ───");
  deps.toLLMLog(messages[0]?.content ?? "");
  deps.toLLMLog("\n[user]");
  deps.toLLMLog(messages[1]?.content ?? "");

  // Run consensus with early exit - consensus varies sampling params
  let queryIndex = 0;
  const consensusResult = await runWithConsensus<ParsedSelection>(
    async (params: SamplingParams) => {
      queryIndex++;
      deps.spinner.update(`Selecting (${queryIndex})`);
      return runSelectionQuery(messages, deps.toolInventory, params, deps);
    },
    selectionsMatch,
    {
      maxQueries: 7,
      minMatches: 3,
      matchMode: "exact",
      stop: ["\n"],
    }
  );

  // Log results
  for (const [index, result] of consensusResult.allResults.entries()) {
    let desc: string;
    if (result.tool) {
      desc = result.tool;
    } else if (result.isDone) {
      desc = "done";
    } else if (result.question) {
      desc = `question: ${result.question.slice(0, 30)}...`;
    } else {
      desc = "(none)";
    }
    deps.agentLog(`[select] Query ${index + 1}: ${desc}`);
  }

  deps.agentLog(
    `[select] Consensus: ${consensusResult.matchCount} matches from ${consensusResult.queriesRun} queries`
  );

  const selection = consensusResult.result ?? { tool: undefined, isDone: false, question: undefined };
  let selectedDesc: string;
  if (selection.tool) {
    selectedDesc = selection.tool;
  } else if (selection.isDone) {
    selectedDesc = "done";
  } else if (selection.question) {
    selectedDesc = "question";
  } else {
    selectedDesc = "(none)";
  }
  deps.agentLog(`[select] Selected: ${selectedDesc}`);

  return {
    tool: selection.tool,
    isDone: selection.isDone,
    question: selection.question,
    consensusCount: consensusResult.matchCount,
    queriesRun: consensusResult.queriesRun,
  };
}
