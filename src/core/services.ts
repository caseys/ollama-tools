/**
 * Unified wrappers for external services (Ollama LLM, MCP tools).
 */

import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OllamaMessage, OllamaTool } from "../types.js";
import type { RetryWithParamsConfig } from "./retry.js";
import type { OllamaClient, CallOllamaOptions } from "./ollama.js";
import type { ToolEvent } from "./turn-types.js";
import type { ToolLogger } from "../ui/logger.js";
import { retryWithVaryingParams } from "./retry.js";
import { extractAssistantText } from "../utils/strings.js";
import {
  formatMcpResult,
  didToolSucceed,
  type McpToolResult,
} from "../utils/tools.js";

// === LLM Service ===

export interface CallLLMOptions extends CallOllamaOptions {
  maxRetries?: number;
  stop?: string[];
  onRetry?: (attempt: number) => void;
}

export interface CallLLMResult {
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  attempts: number;
}

/**
 * Call the LLM with retry support using varying temperatures.
 */
export async function callLLM(
  ollamaClient: OllamaClient,
  messages: OllamaMessage[],
  tools: OllamaTool[],
  options: CallLLMOptions = {}
): Promise<CallLLMResult> {
  const { maxRetries = 2, stop, onRetry, ...callOptions } = options;

  const retryConfig: RetryWithParamsConfig = {
    maxAttempts: maxRetries,
    onRetry: (attempt) => { onRetry?.(attempt); },
  };
  if (stop) {
    retryConfig.stop = stop;
  }

  const { result, attempts } = await retryWithVaryingParams<OllamaMessage>(
    async (params) => {
      const response = await ollamaClient.call(messages, tools, {
        ...callOptions,
        options: {
          ...callOptions.options,
          temperature: params.temperature,
          top_p: params.top_p,
          top_k: params.top_k,
          ...(params.stop && { stop: params.stop }),
        },
      });
      return response.message;
    },
    (msg) => !msg || (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)),
    retryConfig
  );

  const content = result ? extractAssistantText(result) : "";
  const toolCalls = (result?.tool_calls ?? []).map((tc) => ({
    name: tc.function.name,
    arguments: tc.function.arguments ?? {},
  }));

  return { content, toolCalls, attempts };
}

// === MCP Tool Service ===

export interface CallMcpToolOptions {
  timeout: number;
  progressCallback?: (message: string) => void;
  groupId: string;
}

export interface CallMcpToolResult {
  event: ToolEvent;
  rawResult: McpToolResult;
}

export interface CallMcpToolLoggers {
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
}

/**
 * Call an MCP tool and return a structured ToolEvent.
 */
export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  options: CallMcpToolOptions,
  loggers: CallMcpToolLoggers
): Promise<CallMcpToolResult> {
  const progressToken = randomUUID();
  const eventId = randomUUID();

  // Log the call
  const argsDisplay = Object.keys(args).length > 0 ? JSON.stringify(args) : "(no args)";
  loggers.toToolLog(toolName, argsDisplay);

  // Call the tool
  const result = (await client.callTool(
    {
      name: toolName,
      arguments: args,
      _meta: { progressToken },
    },
    undefined,
    {
      timeout: options.timeout,
      resetTimeoutOnProgress: true,
      onprogress: (progress) => {
        if (progress.message) {
          options.progressCallback?.(progress.message);
        }
      },
    }
  )) as McpToolResult;

  // Format and log the result
  const textResult = formatMcpResult(result);
  const success = didToolSucceed(result);

  // Log the result - show full details for errors, first line for success
  if (success) {
    loggers.fromToolLog(toolName, textResult.split("\n")[0] ?? "");
  } else {
    // For errors, log each line to show full error details
    for (const line of textResult.split("\n").filter(l => l.trim())) {
      loggers.fromToolLog(toolName, line);
    }
  }

  // Build the event
  const event: ToolEvent = {
    id: eventId,
    toolName,
    args,
    result: textResult,
    success,
    timestamp: Date.now(),
    groupId: options.groupId,
  };

  return { event, rawResult: result };
}
