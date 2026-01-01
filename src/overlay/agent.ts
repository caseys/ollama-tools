import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentPromptsLazy } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import { truncateMiddle, extractAssistantText } from "../utils/strings.js";
import { fetchStatusInfo, type ResourceReaderDeps } from "../mcp/resources.js";

export interface GenerateAgentPromptsDeps extends ResourceReaderDeps {
  ollamaClient: OllamaClient;
  agentLog: Logger;
}

export async function generateAgentPrompts(
  toolInventory: InventoryEntry[],
  client: Client,
  deps: GenerateAgentPromptsDeps
): Promise<AgentPromptsLazy> {
  const toolNames = toolInventory.map((t) => t.openAi.function.name).join(", ");

  deps.agentLog("[agent] Reading status resource for intro context...");
  const { statusInfo } = await fetchStatusInfo(client, deps, "Intro ");
  if (statusInfo) {
    deps.agentLog(`[agent] Status: ${truncateMiddle(statusInfo, 100)}`);
  }

  // Generate user-facing greeting (awaited - needed immediately)
  const userRolePrompt = `TOOLS: ${toolNames}

STATUS:
${statusInfo || "No status available."}

TASK: Write a short, 1 sentence greeting describing what you can help with.
Write in first person: "I can help you..."
Focus on what you can accomplish with these TOOLS considering STATUS.`;

  const userRoleResult = await deps.ollamaClient.call(
    [{ role: "user", content: userRolePrompt }],
    [],
    { spinnerMessage: "Initializing: greeting" }
  );
  const roleForUser = extractAssistantText(userRoleResult.message);

  if (!roleForUser || roleForUser.trim() === "") {
    throw new Error("LLM returned empty response for user greeting");
  }

  // Generate assistant mission statement (background - not needed until first pipeline run)
  const assistantRolePrompt = `TOOLS: ${toolNames}

STATUS:
${statusInfo || "No status available."}

TASK: Write a 1-2 sentence mission statement for yourself when selecting and executing tools.
Write in second person: "You are a [role title]..."
Create a role title that describes your work with these TOOLS.`;

  const roleForAssistantPromise = deps.ollamaClient.call(
    [{ role: "user", content: assistantRolePrompt }],
    [],
    { silent: true }
  ).then((result) => {
    const text = extractAssistantText(result.message);
    if (!text || text.trim() === "") {
      throw new Error("LLM returned empty response for assistant role");
    }
    return text;
  });

  return { roleForUser, roleForAssistantPromise };
}
