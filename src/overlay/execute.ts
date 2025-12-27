import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts, ToolExecutionResult } from "../types.js";
import type { Logger, ToolLogger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { HISTORY_EVENT_TEXT_LIMIT, SINGLE_TOOL_RULES } from "../config/constants.js";
import { truncateMiddle } from "../utils/strings.js";
import { describeError } from "../ui/logger.js";
import {
  findToolEntry,
  normalizeArgumentsForEntry,
  safeParseArguments,
  formatMcpResult,
  didToolSucceed,
  formatParameterHints,
  type McpToolResult,
} from "../utils/tools.js";
import { createStep } from "../core/pipeline.js";

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

  const systemLines: string[] = [
    agentPrompts.roleForAssistant,
    "",
    SINGLE_TOOL_RULES,
    "",
    `TASK: Step ${step}/${total} - Call "${tool.name}"`,
    "",
    `TOOL: ${tool.name}`,
    tool.description,
  ];

  if (parameterHints) {
    systemLines.push("", "PARAMETERS:", parameterHints);
  }

  if (previousResult ?? nextTool) {
    systemLines.push("", "CONTEXT:");
    if (previousResult) {
      systemLines.push(
        `- Previous step: ${previousResult.tool} → ${previousResult.result}`
      );
    }
    if (nextTool) {
      systemLines.push(`- Next step: ${nextTool}`);
    }
  }

  systemLines.push("", "USER REQUEST:");

  return {
    system: systemLines.join("\n"),
    user: userQuery,
  };
}

export function buildToolRetryPrompt(
  userQuery: string,
  toolEntry: InventoryEntry,
  errorMessage: string,
  attempt: number,
  maxAttempts: number,
  step: number,
  total: number,
  agentPrompts: AgentPrompts
): ToolPromptResult {
  const tool = toolEntry.openAi.function;
  const parameterHints = formatParameterHints(tool);

  const systemLines: string[] = [
    agentPrompts.roleForAssistant,
    "",
    SINGLE_TOOL_RULES,
    "",
    `TASK: Step ${step}/${total} - Call "${tool.name}"`,
    `ATTEMPT: ${attempt} of ${maxAttempts}`,
    "",
    `TOOL: ${tool.name}`,
    tool.description,
  ];

  if (parameterHints) {
    systemLines.push("", "PARAMETERS:", parameterHints);
  }

  systemLines.push("", "PREVIOUS ERROR:", errorMessage, "", "USER REQUEST:");

  return {
    system: systemLines.join("\n"),
    user: userQuery,
  };
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

  for (let index = 0; index < toolSequence.length; index++) {
    const toolName = toolSequence[index]!;
    const toolEntry = findToolEntry(toolInventory, toolName);
    if (!toolEntry) {
      deps.agentWarn(
        `[agent] Tool "${toolName}" not found in inventory, skipping.`
      );
      continue;
    }

    const nextTool =
      index < toolSequence.length - 1 ? toolSequence[index + 1] : undefined;

    const focusedPrompt = buildFocusedToolPrompt(
      userPrompt,
      toolEntry,
      previousResult,
      nextTool,
      index + 1,
      toolSequence.length,
      agentPrompts
    );

    deps.agentLog(
      `[agent] Step ${index + 1}/${toolSequence.length}: Calling ${toolName}...`
    );

    let arguments_: Record<string, unknown> = {};
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      const systemToUse =
        attempts === 1
          ? focusedPrompt.system
          : `You MUST call the "${toolName}" tool NOW. This is required.\n\n${focusedPrompt.system}`;

      const response = await deps.ollamaClient.call(
        [
          { role: "system", content: systemToUse },
          { role: "user", content: focusedPrompt.user },
        ],
        [toolEntry.openAi],
        { format: "json", spinnerMessage: `Step ${index + 1}: ${toolName}` }
      );

      const toolCalls = response.message?.tool_calls ?? [];

      if (toolCalls.length > 0) {
        const call = toolCalls[0]!;
        arguments_ = normalizeArgumentsForEntry(
          toolEntry,
          safeParseArguments(call.function?.arguments)
        );
        break;
      }

      if (attempts < maxAttempts) {
        deps.agentWarn(
          `[agent] Model didn't call ${toolName}. Retrying with stronger prompt...`
        );
      } else {
        deps.agentWarn(
          `[agent] Model didn't call ${toolName} after ${maxAttempts} attempts. Using empty args.`
        );
      }
    }

    const maxToolAttempts = 2;
    let toolSucceeded = false;

    for (let toolAttempt = 1; toolAttempt <= maxToolAttempts; toolAttempt++) {
      deps.toToolLog(
        toolName,
        Object.keys(arguments_).length > 0
          ? JSON.stringify(arguments_)
          : "(no args)"
      );

      try {
        const progressToken = randomUUID();
        const result = (await client.callTool(
          {
            name: toolName,
            arguments: arguments_,
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
          deps.agentWarn(`[agent] Tool ${toolName} failed. Stopping sequence.`);
          if (result.structuredContent) {
            deps.agentWarn(
              `[agent] Structured: ${JSON.stringify(result.structuredContent)}`
            );
          }
        }
        break;
      } catch (error) {
        const message = describeError(error);

        if (toolAttempt < maxToolAttempts) {
          deps.agentWarn(
            `[agent] Tool ${toolName} threw error: ${message}. Retrying...`
          );

          const retryPrompt = buildToolRetryPrompt(
            userPrompt,
            toolEntry,
            message,
            toolAttempt + 1,
            maxToolAttempts,
            index + 1,
            toolSequence.length,
            agentPrompts
          );

          const retryResponse = await deps.ollamaClient.call(
            [
              { role: "system", content: retryPrompt.system },
              { role: "user", content: retryPrompt.user },
            ],
            [toolEntry.openAi],
            {
              format: "json",
              spinnerMessage: `Step ${index + 1}: ${toolName} (retry)`,
            }
          );

          const retryToolCalls = retryResponse.message?.tool_calls ?? [];
          if (retryToolCalls.length > 0) {
            arguments_ = normalizeArgumentsForEntry(
              toolEntry,
              safeParseArguments(retryToolCalls[0]!.function?.arguments)
            );
          }
          continue;
        }

        deps.agentError(`[agent] Tool ${toolName} threw error: ${message}`);
        toolEvents.push({
          name: toolName,
          success: false,
          summary: truncateMiddle(message, HISTORY_EVENT_TEXT_LIMIT),
        });
      }
    }

    if (!toolSucceeded) {
      break;
    }
  }

  return { toolEvents: toolEvents.map(e => ({
    tool: e.name,
    args: {},
    result: e.summary,
    status: e.success ? "success" : "failure"
  })) };
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
  },
  (ctx: PipelineContext): boolean =>
    ctx.branch === "execute" && (ctx.plannedTools?.length ?? 0) > 0
);
