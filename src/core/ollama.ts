import type { Config, OllamaMessage, OllamaTool, OllamaResponse } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import { extractAssistantText } from "../utils/strings.js";
import { blankLine } from "../ui/output.js";

export interface CallOllamaOptions {
  options?: Record<string, unknown>;
  silent?: boolean;
  spinnerMessage?: string;
  format?: unknown;
  [key: string]: unknown;
}

export interface OllamaClient {
  call: (
    messages: OllamaMessage[],
    tools: OllamaTool[],
    overrides?: CallOllamaOptions
  ) => Promise<OllamaResponse>;
  callWithSignal: (
    messages: OllamaMessage[],
    tools: OllamaTool[],
    signal: AbortSignal | undefined,
    overrides?: CallOllamaOptions
  ) => Promise<OllamaResponse>;
}

export interface OllamaClientDeps {
  config: Config;
  spinner: Spinner;
  toLLMLog: Logger;
  fromLLMLog: Logger;
  agentWarn: Logger;
}

export function createOllamaClient(deps: OllamaClientDeps): OllamaClient {
  const { config, spinner, toLLMLog, fromLLMLog, agentWarn } = deps;

  async function callWithSignal(
    messages: OllamaMessage[],
    tools: OllamaTool[],
    signal: AbortSignal | undefined,
    overrides: CallOllamaOptions = {}
  ): Promise<OllamaResponse> {
    const maxRetries = Math.max(1, config.maxRetries || 1);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const {
          options: optionOverrides,
          silent,
          spinnerMessage,
          ...restOverrides
        } = overrides;

        const body = {
          model: config.model,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
          options: {
            num_ctx: 2048,
            ...optionOverrides,
          },
          ...restOverrides,
        };

        if (!silent) {
          toLLMLog("[toLLM] ─── Prompt ───");
          for (const message of messages) {
            const content =
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content);
            toLLMLog(`[${message.role}]`);
            toLLMLog(content);
            blankLine(config.debug);
          }
          if (tools?.length) {
            const toolNames = tools.map((t) => t.function?.name || "(unknown)");
            toLLMLog(`[tools] ${toolNames.join(", ")}`);
          }
        }

        const fetchOptions: RequestInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        };
        if (signal) {
          fetchOptions.signal = signal;
        }

        if (!silent && spinnerMessage) {
          spinner.start(spinnerMessage);
        }
        let response: Response;
        try {
          response = await fetch(`${config.ollamaUrl}/api/chat`, fetchOptions);
        } catch (error) {
          spinner.stop();
          throw error;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Ollama call failed with status ${response.status}: ${text}`
          );
        }
        const result = (await response.json()) as OllamaResponse;

        if (!silent) {
          fromLLMLog("[fromLLM] ─── Response ───");
          const message = result.message;
          if (message) {
            const content = extractAssistantText(message);
            if (content) {
              fromLLMLog(`[content] ${content}`);
            }
            if (message.tool_calls?.length) {
              fromLLMLog(`[tool_calls] ${message.tool_calls.length} call(s):`);
              for (const call of message.tool_calls) {
                const args = call.function?.arguments;
                const argsString =
                  args && Object.keys(args).length > 0
                    ? JSON.stringify(args)
                    : "{}";
                fromLLMLog(`  ${call.function?.name}(${argsString})`);
              }
            }
          }
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Planning step timed out");
        }
        if (attempt === maxRetries) {
          throw error;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
        agentWarn(
          `[agent] Ollama call failed, retrying in ${delay}ms (${attempt}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error("Unexpected: exhausted retries without result");
  }

  async function call(
    messages: OllamaMessage[],
    tools: OllamaTool[],
    overrides: CallOllamaOptions = {}
  ): Promise<OllamaResponse> {
    return callWithSignal(messages, tools, undefined, overrides);
  }

  return { call, callWithSignal };
}
