import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentPrompts } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import { truncateMiddle, extractAssistantText } from "../utils/strings.js";
import { fetchStatusInfo, type ResourceReaderDeps } from "../mcp/resources.js";

export const AGENT_PROMPT_FIELDS = {
  roleForUser:
    "A 1-2 sentence greeting describing what you (the assistant) can help with. Written in first person (I can help you...).",
  roleForAssistant:
    "A 1-2 sentence mission statement for yourself when selecting and executing tools. Written in first person (I help the user...).",
} as const;

export interface GenerateAgentPromptsDeps extends ResourceReaderDeps {
  ollamaClient: OllamaClient;
  agentLog: Logger;
}

export async function generateAgentPrompts(
  toolInventory: InventoryEntry[],
  client: Client,
  deps: GenerateAgentPromptsDeps
): Promise<AgentPrompts> {
  const responseSchema = {
    type: "object",
    properties: {
      role_for_user: {
        type: "string",
        description: AGENT_PROMPT_FIELDS.roleForUser,
      },
      role_for_assistant: {
        type: "string",
        description: AGENT_PROMPT_FIELDS.roleForAssistant,
      },
    },
    required: ["role_for_user", "role_for_assistant"],
  };

  const toolNames = toolInventory.map((t) => t.openAi.function.name).join(", ");

  deps.agentLog("[agent] Reading ksp://status resource for intro context...");
  const { statusInfo } = await fetchStatusInfo(client, deps, "Intro ");
  if (statusInfo) {
    deps.agentLog(`[agent] Status: ${truncateMiddle(statusInfo, 100)}`);
  }

  const response = await deps.ollamaClient.call(
    [
      {
        role: "user",
        content: `TOOLS: ${toolNames}

STATUS:
${statusInfo || "No status available."}

TASK: Write summaries in these forms:

{
  "role_for_user": "I can help [describe what you can accomplish with these TOOLS considering STATUS in one sentence]...",
  "role_for_assistant": "You are a [create role title/name that descibes your work with these TOOLS ]..."
}

OUTPUT: JSON object with role_for_user and role_for_assistant fields.`,
      },
    ],
    [],
    { format: responseSchema, spinnerMessage: "Initializing" }
  );

  const text = extractAssistantText(response.message);
  if (!text || text.trim() === "") {
    deps.agentLog(
      "[agent] Debug - raw response:",
      JSON.stringify(response.message, undefined, 2)
    );
    throw new Error("LLM returned empty response for agent prompts");
  }

  const parsed = JSON.parse(text) as { role_for_user: string; role_for_assistant: string };
  return {
    roleForUser: parsed.role_for_user,
    roleForAssistant: parsed.role_for_assistant,
  };
}
