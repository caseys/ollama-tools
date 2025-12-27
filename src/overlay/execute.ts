import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts, ToolExecutionResult, ReflectionDecision } from "../types.js";
import type { Logger, ToolLogger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { HISTORY_EVENT_TEXT_LIMIT} from "../config/constants.js";
import { truncateMiddle, extractAssistantText } from "../utils/strings.js";
import { describeError } from "../ui/logger.js";
import {
  findToolEntry,
  findToolMatch,
  normalizeArgumentsForEntry,
  safeParseArguments,
  formatMcpResult,
  didToolSucceed,
  formatParameterHints,
  formatToolsByTier,
  type McpToolResult,
} from "../utils/tools.js";
import { fetchStatusInfo } from "../mcp/resources.js";
import { createStep, retryOnEmpty } from "../core/pipeline.js";

// --- Prompt Types ---

export interface PreviousResult {
  tool: string;
  result: string;
}

export interface ToolPromptResult {
  system: string;
  user: string;
}

// --- Prompt Builders (from tool.ts) ---

export function buildFocusedToolPrompt(
  userQuery: string,
  toolEntry: InventoryEntry,
  previousResult: PreviousResult | undefined,
  nextTool: string | undefined,
  step: number,
  total: number,
  agentPrompts: AgentPrompts
): ToolPromptResult {
  const tool = toolEntry.openAi.function;
  const parameterHints = formatParameterHints(tool);

  const system = `${agentPrompts.roleForAssistant}

TOOL: ${tool.name}
${tool.description}${parameterHints ? `

PARAMETERS:
${parameterHints}` : ""}${previousResult || nextTool ? `

CONTEXT:${previousResult ? `
- Current tool step: ${step}/${total}
- Previous step: ${previousResult.tool} → ${previousResult.result}` : ""}${nextTool ? `
- Next step: ${nextTool}` : ""}` : ""}

TASK: Extract arguments for this tool user query and call "${tool.name}".
1. You MUST call the provided tool for this step.
2. Replace invalid names/values with valid names from TOOLS or STATUS - speech-to-text may mangle argument values.
3. NO argument should be provided unless specified in user input.
4. Do NOT make up argument values.`;

  return { system, user: userQuery };
}

// --- Reflection ---

const REFLECTION_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["continue", "stop", "replan", "ask"],
    },
    reason: { type: "string" },
    tools: { type: "array", items: { type: "string" } },
    question: { type: "string" },
  },
  required: ["action"],
};

interface ReflectParams {
  toolName: string;
  textResult: string;
  remainingTools: string[];
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  client: Client;
  deps: ExecutorDeps;
}

async function reflectOnResult(params: ReflectParams): Promise<ReflectionDecision> {
  const { toolName, textResult, remainingTools, toolInventory, agentPrompts, client, deps } = params;

  // Fetch fresh status for accurate reflection
  const { statusInfo } = await fetchStatusInfo(
    client,
    { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
    "Reflecting"
  );

  const prompt = `${agentPrompts.roleForAssistant}

COMPLETED:
${toolName}: ${textResult}

REMAINING PLAN:
${remainingTools.join(" → ") || "(done)"}

AVAILABLE TOOLS:
${formatToolsByTier(toolInventory)}

STATUS:
${statusInfo || "No status available."}

TASK: Evaluate the result and decide next action.
- "continue": Proceed with remaining plan (result looks good)
- "stop": Abort remaining steps (explain problem in reason)
- "replan": Replace remaining plan with different tools (provide tools array + reason)
- "ask": Need user clarification (provide question)

OUTPUT: JSON with action field, plus reason/tools/question as needed.`;

  const response = await deps.ollamaClient.call(
    [{ role: "system", content: prompt }],
    [],
    {
      format: REFLECTION_SCHEMA,
      spinnerMessage: "Reflecting",
      silent: true,
    }
  );

  const text = extractAssistantText(response.message).trim();
  if (!text) {
    deps.agentLog("[agent] Reflection returned empty, continuing...");
    return { action: "continue" };
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const action = parsed.action as string;

    if (action === "stop" && typeof parsed.reason === "string") {
      return { action: "stop", reason: parsed.reason };
    }
    if (action === "replan" && Array.isArray(parsed.tools) && typeof parsed.reason === "string") {
      // Validate tool names
      const validTools = (parsed.tools as string[])
        .map((name) => {
          const lowerMap = new Map(toolInventory.map((e) => [e.openAi.function.name.toLowerCase(), e.openAi.function.name]));
          return findToolMatch(name, lowerMap);
        })
        .filter((t): t is string => t !== undefined);
      if (validTools.length > 0) {
        return { action: "replan", tools: validTools, reason: parsed.reason };
      }
    }
    if (action === "ask" && typeof parsed.question === "string") {
      return { action: "ask", question: parsed.question };
    }

    return { action: "continue" };
  } catch {
    deps.agentLog("[agent] Failed to parse reflection, continuing...");
    return { action: "continue" };
  }
}

// --- Executor Dependencies ---

export interface ExecutorDeps {
  config: Config;
  ollamaClient: OllamaClient;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  agentError: Logger;
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
  say: (text: string) => void;
}

// --- Sequential Tool Execution (from executor.ts) ---

export async function runSequentialToolExecution(
  userPrompt: string,
  toolSequence: string[],
  toolInventory: InventoryEntry[],
  client: Client,
  agentPrompts: AgentPrompts,
  deps: ExecutorDeps
): Promise<ToolExecutionResult> {
  const toolEvents: Array<{
    name: string;
    success: boolean;
    summary: string;
  }> = [];
  let previousResult: PreviousResult | undefined;
  let stopped: { reason: string } | undefined;
  let question: string | undefined;

  // Mutable copy for replan support
  const tools = [...toolSequence];

  executionLoop: for (let index = 0; index < tools.length; index++) {
    const toolName = tools[index]!;
    const toolEntry = findToolEntry(toolInventory, toolName);
    if (!toolEntry) {
      deps.agentWarn(
        `[agent] Tool "${toolName}" not found in inventory, skipping.`
      );
      continue;
    }

    const nextTool =
      index < tools.length - 1 ? tools[index + 1] : undefined;

    const focusedPrompt = buildFocusedToolPrompt(
      userPrompt,
      toolEntry,
      previousResult,
      nextTool,
      index + 1,
      tools.length,
      agentPrompts
    );

    deps.agentLog(
      `[agent] Step ${index + 1}/${tools.length}: Calling ${toolName}...`
    );

    const { result: arguments_ } = await retryOnEmpty(
      async () => {
        const response = await deps.ollamaClient.call(
          [
            { role: "system", content: focusedPrompt.system },
            { role: "user", content: focusedPrompt.user },
          ],
          [toolEntry.openAi],
          { spinnerMessage: `Step ${index + 1}: ${toolName}` }
        );
        const toolCalls = response.message?.tool_calls ?? [];
        if (toolCalls.length === 0) return null;
        return normalizeArgumentsForEntry(
          toolEntry,
          safeParseArguments(toolCalls[0]!.function?.arguments)
        );
      },
      (r) => r === null,
      {
        maxAttempts: 2,
        onRetry: () => deps.agentWarn(`[agent] Model didn't call ${toolName}. Retrying...`),
      }
    );

    deps.toToolLog(
      toolName,
      Object.keys(arguments_ ?? {}).length > 0
        ? JSON.stringify(arguments_)
        : "(no args)"
    );

    let toolSucceeded = false;

    try {
      const progressToken = randomUUID();
      const result = (await client.callTool(
        {
          name: toolName,
          arguments: arguments_ ?? {},
          _meta: { progressToken },
        },
        undefined,
        {
          timeout: deps.config.toolTimeout,
          resetTimeoutOnProgress: true,
          onprogress: (progress: { progress: number; total?: number | undefined; message?: string | undefined }) => {
            if (progress.message) {
              deps.spinner.update(progress.message);
            }
          },
        }
      )) as McpToolResult;

      const textResult = formatMcpResult(result);
      deps.fromToolLog(toolName, textResult.split("\n")[0] ?? "");
      deps.say(textResult.split("\n")[0] ?? "");

      if (textResult.includes("\n")) {
        for (const line of textResult.split("\n").slice(1)) {
          if (line.trim()) deps.fromToolLog(toolName, `  ${line}`);
        }
      }

      const success = didToolSucceed(result);
      toolEvents.push({
        name: toolName,
        success,
        summary: truncateMiddle(textResult, HISTORY_EVENT_TEXT_LIMIT),
      });

      previousResult = { tool: toolName, result: textResult };
      toolSucceeded = success;

      if (!success) {
        deps.agentError(`[agent] Tool ${toolName} failed. Stopping sequence.`);
        if (result.structuredContent) {
          deps.agentError(
            `[agent] Structured: ${JSON.stringify(result.structuredContent)}`
          );
        }
      } else {
        // Reflect on successful tool result (always, even on last tool)
        const remainingTools = tools.slice(index + 1);
        const decision = await reflectOnResult({
          toolName,
          textResult,
          remainingTools,
          toolInventory,
          agentPrompts,
          client,
          deps,
        });

        switch (decision.action) {
          case "stop":
            deps.agentLog(`[agent] Stopping: ${decision.reason}`);
            stopped = { reason: decision.reason };
            break executionLoop;
          case "replan":
            deps.agentLog(`[agent] Replanning: ${decision.reason}`);
            deps.agentLog(`[agent] New plan: ${decision.tools.join(" → ")}`);
            // Replace remaining tools (can add new ones even if none were remaining)
            tools.splice(index + 1, tools.length, ...decision.tools);
            break;
          case "ask":
            deps.agentLog(`[agent] Needs input: ${decision.question}`);
            question = decision.question;
            break executionLoop;
          case "continue":
          default:
            // Proceed normally
            break;
        }
      }
    } catch (error) {
      const message = describeError(error);
      deps.agentError(`[agent] Tool ${toolName} threw error: ${message}`);
      toolEvents.push({
        name: toolName,
        success: false,
        summary: truncateMiddle(message, HISTORY_EVENT_TEXT_LIMIT),
      });
    }

    if (!toolSucceeded) {
      break;
    }
  }

  const result: ToolExecutionResult = {
    toolEvents: toolEvents.map(e => ({
      tool: e.name,
      args: {},
      result: e.summary,
      status: e.success ? "success" : "failure"
    })),
  };
  if (stopped) result.stopped = stopped;
  if (question) result.question = question;
  return result;
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "execute",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const result = await runSequentialToolExecution(
      ctx.userInput,
      ctx.plannedTools!,
      ctx.toolInventory,
      deps.client,
      ctx.agentPrompts,
      {
        config: deps.config,
        ollamaClient: deps.ollamaClient,
        spinner: deps.spinner,
        agentLog: deps.agentLog,
        agentWarn: deps.agentWarn,
        agentError: deps.agentError,
        toToolLog: deps.toToolLog,
        fromToolLog: deps.fromToolLog,
        say: deps.say,
      }
    );
    ctx.toolResults = result.toolEvents;
    if (result.stopped) ctx.reflectionStopped = result.stopped;
    if (result.question) ctx.reflectionQuestion = result.question;
  },
  (ctx: PipelineContext): boolean =>
    ctx.branch === "execute" && (ctx.plannedTools?.length ?? 0) > 0
);
