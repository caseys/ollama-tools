import type { OllamaTool, ToolInputSchema } from "../types.js";
import type { InventoryEntry } from "../utils/tools.js";

interface McpToolInput {
  name: string;
  description?: string | undefined;
  inputSchema?: {
    type: "object";
    properties?: Record<string, object> | undefined;
    required?: string[] | undefined;
    [key: string]: unknown;
  } | undefined;
  _meta?: {
    tier?: number | undefined;
  } | undefined;
}

export function convertToolsForOllama(tools: McpToolInput[]): InventoryEntry[] {
  return tools.map((tool) => {
    const inputSchema: ToolInputSchema = {
      type: "object",
      properties: (tool.inputSchema?.properties ?? {}) as Record<string, { type: string; description?: string }>,
      required: tool.inputSchema?.required,
    };

    const openAiTool: OllamaTool = {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "MCP tool",
        parameters: inputSchema,
      },
    };

    const parameterKeys = Object.keys(inputSchema.properties ?? {});

    return {
      openAi: openAiTool,
      parameterKeys,
      tier: tool._meta?.tier ?? 2,
    };
  });
}
