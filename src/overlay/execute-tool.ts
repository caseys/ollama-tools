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
import type { Logger, ToolLogger } from "../ui/logger.js";
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
  say: (text: string) => void;
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

  const previousContext = previousResult
    ? `\n\nCONTEXT:
- Iteration: ${iteration}/${maxIterations}
- Previous: ${previousResult.toolName} \u2192 ${previousResult.result.split("\n")[0]}`
    : "";

  const system = `${agentPrompts.roleForAssistant}

TOOL: ${tool.name}
${tool.description}${parameterHints ? `

PARAMETERS:
${parameterHints}` : ""}${previousContext}

TASK: Extract arguments for this tool from the user query and call "${tool.name}".
1. You MUST call the provided tool.
2. Replace invalid names/values with valid ones - speech-to-text may mangle argument values.
3. Only provide arguments explicitly specified or clearly implied by the user.
4. Do NOT make up argument values.`;

  return { system, user: userQuery };
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
    [toolEntry.openAi],
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

  // Extract and normalize arguments
  const rawArgs = llmResult.toolCalls[0]?.arguments ?? {};
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

    // Announce result
    const firstLine = event.result.split("\n")[0] ?? "";
    deps.say(firstLine);

    if (!event.success) {
      deps.agentError(`[execute] Tool ${toolName} failed`);
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
