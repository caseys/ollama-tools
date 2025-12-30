/**
 * ask_user tool - internal escape hatch for argument clarification
 *
 * When the LLM cannot extract required arguments from the user query,
 * it can call this tool to request clarification. The question is
 * presented to the user, and their answer is fed back into the
 * execute step for the original tool.
 *
 * This tool is NOT an MCP tool - it's handled internally by ollama-tools.
 */

import type { OllamaTool } from "../types.js";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: ASK_USER_TOOL_NAME,
    description:
      "Ask the user a question to clarify tool arguments or context. " +
      "Use ONLY when a required argument is genuinely missing and cannot be inferred from the query. " +
      "This is a LAST RESORT - prefer extracting arguments from context when possible.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user (be specific about what you need)",
        },
      },
      required: ["question"],
    },
  },
};

/**
 * Check if a tool call is the ask_user escape hatch
 */
export function isAskUserCall(toolName: string): boolean {
  return toolName === ASK_USER_TOOL_NAME;
}
