/**
 * Execute Tool step: runs a single tool.
 *
 * Simplified from the old execute.ts:
 * - Executes ONE tool per call (no loop)
 * - Uses callMcpTool from services.ts
 * - Returns ToolEvent
 * - No embedded reflection logic (moved to reflect.ts)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts } from "../types.js";
import type { Logger, ToolLogger, ResultLogger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { TurnWorkingState, ToolEvent } from "../core/turn-types.js";
import { randomUUID } from "node:crypto";
import { callLLM, callMcpTool } from "../core/services.js";
import {
  findToolEntry,
  normalizeArgumentsForEntry,
  safeParseArguments,
  formatParameterHints,
} from "../utils/tools.js";
import { ASK_USER_TOOL, isAskUserCall } from "../tools/ask-user.js";

// === Dependencies ===

export interface ExecuteToolDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  agentError: Logger;
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
  resultLog: ResultLogger;
  say: (text: string) => void;
  sayResult: (text: string) => void;
}

// === Prompt Building ===

interface ToolPromptResult {
  system: string;
  user: string;
}

function buildFocusedToolPrompt(
  userQuery: string,
  toolEntry: InventoryEntry,
  previousResult: ToolEvent | undefined,
  iteration: number,
  maxIterations: number,
  agentPrompts: AgentPrompts
): ToolPromptResult {
  const tool = toolEntry.openAi.function;
  const parameterHints = formatParameterHints(tool);

  // ALWAYS show pipeline context - critical for LLM to understand scope
  const pipelineInfo = `PIPELINE: Step ${iteration} of up to ${maxIterations}. Other steps handle the rest of the mission.`;

  const previousContext = previousResult
    ? `\nPrevious: ${previousResult.toolName} \u2192 ${previousResult.result.split("\n")[0]}`
    : "";

  const system = `${agentPrompts.roleForAssistant}

${pipelineInfo}${previousContext}

TOOL: ${tool.name}
${tool.description}${parameterHints ? `

PARAMETERS:
${parameterHints}` : ""}

YOUR ONLY JOB: Call "${tool.name}" with arguments from the query below. Do NOT output text.

RULES:
1. Call ${tool.name} - extract arguments from the query.
2. Other tools handle future steps. Do NOT worry about the full mission.
3. Fix speech-to-text errors in argument values.
4. Replace invalid argument names with valid names from STATUS (fix speech-to-text errors).
5. LAST RESORT: Call ask_user("question") if a required argument is genuinely missing. Do not ask about invalid nouns`;

  return { system, user: userQuery };
}

// === Speech Helpers ===

const GENERIC_ERROR_WORDS = ["error", "failed", "failure", "exception", "err"];

function isGenericErrorLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  return GENERIC_ERROR_WORDS.some(word => lower === word || lower === `${word}:`);
}

function buildSpokenResult(
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  result: string
): string {
  const readableName = toolName.replaceAll("_", " ");

  if (success) {
    // For success, use first meaningful line
    const firstLine = result.split("\n")[0] ?? "";
    return firstLine || `${readableName} completed`;
  }

  // For errors, build descriptive message
  const lines = result.split("\n").filter(l => l.trim());
  const firstLine = lines[0] ?? "";

  // Find first meaningful error line (skip generic "ERROR" lines)
  let errorDetail = "";
  for (const line of lines) {
    if (!isGenericErrorLine(line)) {
      errorDetail = line;
      break;
    }
  }

  // Build spoken message
  const argsCount = Object.keys(args).length;
  const argsDesc = argsCount > 0 ? ` with ${argsCount} argument${argsCount > 1 ? "s" : ""}` : "";

  if (errorDetail && !isGenericErrorLine(errorDetail)) {
    return `${readableName}${argsDesc} failed: ${errorDetail}`;
  }
  return `${readableName}${argsDesc} failed`;
}

// === Main Function ===

export async function executeTool(
  state: TurnWorkingState,
  deps: ExecuteToolDeps
): Promise<ToolEvent> {
  const toolName = state.currentTool;

  if (!toolName) {
    deps.agentError("[execute] No tool selected");
    return {
      id: randomUUID(),
      toolName: "(none)",
      args: {},
      result: "No tool was selected for execution",
      success: false,
      timestamp: Date.now(),
      groupId: state.groupId,
    };
  }

  deps.agentLog(`[execute] Running ${toolName} (iteration ${state.iteration})`);

  // Find the tool entry
  const toolEntry = findToolEntry(deps.toolInventory, toolName);
  if (!toolEntry) {
    deps.agentWarn(`[execute] Tool "${toolName}" not found in inventory`);
    return {
      id: randomUUID(),
      toolName,
      args: {},
      result: `Tool "${toolName}" not found`,
      success: false,
      timestamp: Date.now(),
      groupId: state.groupId,
    };
  }

  // Build focused prompt for argument extraction
  const previousResult = state.groupToolResults.at(-1);
  const prompt = buildFocusedToolPrompt(
    state.remainingQuery,
    toolEntry,
    previousResult,
    state.iteration,
    state.maxIterations,
    deps.agentPrompts
  );

  // Get arguments via LLM
  deps.spinner.start(`Step ${state.iteration}: ${toolName}`);

  const llmResult = await callLLM(
    deps.ollamaClient,
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    [toolEntry.openAi, ASK_USER_TOOL],  // Include ask_user as escape hatch
    {
      spinnerMessage: `Step ${state.iteration}: ${toolName}`,
      maxRetries: 2,
      onRetry: () => {
        deps.agentWarn(`[execute] Model didn't call ${toolName}. Retrying...`);
      },
    }
  );

  // Log any text content that gets ignored during tool calling
  if (llmResult.content.trim()) {
    deps.agentLog(`[execute] IGNORED LLM TEXT DURING TOOL CALL: ${llmResult.content}`);
  }

  // Check if LLM returned no tool call at all
  const calledTool = llmResult.toolCalls[0];
  if (!calledTool) {
    // LLM refused to call tool - return failure with its text for reflect to handle
    const llmText = llmResult.content.trim() || "LLM did not call any tool";
    deps.agentError(`[execute] LLM returned no tool call after ${llmResult.attempts} attempts`);
    deps.agentLog(`[execute] LLM text: ${llmText.slice(0, 200)}`);

    return {
      id: randomUUID(),
      toolName,
      args: {},
      result: `LLM RESULT ERROR: Model did not call ${toolName}.\n\nModel response: ${llmText}`,
      success: false,
      timestamp: Date.now(),
      groupId: state.groupId,
    };
  }

  // Check if LLM called ask_user instead of the target tool
  if (isAskUserCall(calledTool.name)) {
    const question = (calledTool.arguments?.question as string) ?? "Could you clarify?";
    deps.agentLog(`[execute] LLM requested clarification: "${question}"`);

    // Return special event that signals need for user input
    return {
      id: randomUUID(),
      toolName: "ask_user",
      args: { question },
      result: question,
      success: true,
      needsUserInput: true,
      originalTool: toolName,  // Remember what tool we were trying to call
      timestamp: Date.now(),
      groupId: state.groupId,
    };
  }

  // Extract and normalize arguments for the actual tool
  const rawArgs = calledTool.arguments ?? {};
  const args = normalizeArgumentsForEntry(toolEntry, safeParseArguments(rawArgs));

  // Execute the tool
  try {
    const { event } = await callMcpTool(
      deps.client,
      toolName,
      args,
      {
        timeout: deps.config.toolTimeout,
        progressCallback: (msg) => {
          deps.spinner.update(msg);
        },
        groupId: state.groupId,
      },
      {
        toToolLog: deps.toToolLog,
        fromToolLog: deps.fromToolLog,
      }
    );

    // Print full result for user (always visible)
    deps.resultLog(toolName, event.success, event.result);

    // Announce result via speech - clears any stale notifications from queue
    const spokenMessage = buildSpokenResult(toolName, args, event.success, event.result);
    deps.sayResult(spokenMessage);

    if (!event.success) {
      deps.agentError(`[execute] Tool ${toolName} failed: ${event.result.split("\n").slice(0, 3).join(" | ")}`);
    }

    return event;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.agentError(`[execute] Tool ${toolName} threw error: ${message}`);

    return {
      id: randomUUID(),
      toolName,
      args,
      result: message,
      success: false,
      timestamp: Date.now(),
      groupId: state.groupId,
    };
  }
}
