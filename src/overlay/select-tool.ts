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

function parseSingleToolResponse(
  text: string | undefined,
  toolInventory: InventoryEntry[]
): string | undefined {
  if (!text || !text.trim()) return undefined;

  // Check for explicit null/none responses
  const lower = text.toLowerCase().trim();
  if (lower === "null" || lower === "none" || lower === "false") {
    return undefined;
  }

  // Build set of valid tool names (lowercase for comparison)
  const toolNames = new Map(
    toolInventory.map((e) => [e.openAi.function.name.toLowerCase(), e.openAi.function.name])
  );

  // Exact match: find the tool name in the response
  for (const [lowerName, canonicalName] of toolNames) {
    if (lower.includes(lowerName)) {
      return canonicalName;
    }
  }

  return undefined;
}

// === Consensus Matching ===

function toolsMatch(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b;
}

// === Query Building ===

function formatPreviousResults(toolResults: ToolEvent[]): string {
  if (toolResults.length === 0) return "";

  const entries = toolResults.map((e, i) => {
    const statusIcon = e.success ? "\u2713" : "\u2717";
    // Truncate error results to avoid huge MCP error dumps
    let result = e.result;
    if (!e.success && result.length > 200) {
      result = result.slice(0, 200) + "...";
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

  const system = `${agentPrompts.roleForAssistant}

TOOLS:
${formatToolsByTier(toolInventory)}

STATUS:
${statusInfo || "No status available."}

HISTORY (previous sessions):
${historySummary || "This is the first request."}
${previousContext}

ITERATION: ${iteration}/${maxIterations}

TASK: Select the NEXT tool to work toward completing the user request.

RULES:
1. Select ONE tool that advances toward the goal
2. Consider what has already been done in PREVIOUS RESULTS
3. If the request is already satisfied or no tool applies, return null
4. Replace invalid tool names with valid names from TOOLS (fix speech-to-text errors)
5. Do not repeat tools that already succeeded for the same purpose

OUTPUT: Return ONLY the tool name as a JSON string.
Examples: "launch_and_circularize", "hohmann_transfer", or null if done.
Do NOT return objects like {"tool": "name"} - just the string.`;

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
): Promise<string | undefined> {
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
      return undefined;
    }

    deps.agentLog(`[select] Query (temp=${params.temperature}): "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
    return parseSingleToolResponse(text, toolInventory);
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[select] Query failed (temp=${params.temperature}): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// === Result Type ===

export interface SelectToolResult {
  tool: string | undefined;
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

  if (!state.remainingQuery.trim()) {
    deps.agentLog("[select] Empty remaining query, returning undefined");
    return { tool: undefined, consensusCount: 0, queriesRun: 0 };
  }

  // Fetch current status
  const { statusInfo } = await fetchStatusInfo(
    deps.client,
    { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
    "Selecting "
  );

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

  // Run consensus with early exit - consensus varies sampling params
  let queryIndex = 0;
  const consensusResult = await runWithConsensus<string | undefined>(
    async (params: SamplingParams) => {
      queryIndex++;
      deps.spinner.update(`Selecting (${queryIndex})`);
      return runSelectionQuery(messages, deps.toolInventory, params, deps);
    },
    toolsMatch,
    {
      maxQueries: 7,
      minMatches: 3,
      matchMode: "exact",
      stop: ["\n"],
    }
  );

  // Log results
  for (const [index, result] of consensusResult.allResults.entries()) {
    deps.agentLog(`[select] Query ${index + 1}: ${result ?? "(none)"}`);
  }

  deps.agentLog(
    `[select] Consensus: ${consensusResult.matchCount} matches from ${consensusResult.queriesRun} queries`
  );

  const selectedTool = consensusResult.result;
  deps.agentLog(`[select] Selected: ${selectedTool ?? "(none)"}`);

  return {
    tool: selectedTool,
    consensusCount: consensusResult.matchCount,
    queriesRun: consensusResult.queriesRun,
  };
}
